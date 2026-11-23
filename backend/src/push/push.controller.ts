import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';
import { PushService } from './push.service';
import { PushAlertService } from './push-alert.service';
import { CreatePushAlertDto } from './dto/create-push-alert.dto';
import {
  isAllowedPushImageUrl,
  toSaleCheckIconUrl,
} from './push-image.util';
import {
  renderSalePushAmountIcon,
  renderSalePushCard,
  renderSalePushCheckIcon,
} from './sale-push-card.util';
import { buildSalePushTexts } from './sale-push-profit.util';

@Controller('push')
export class PushController {
  constructor(
    private readonly pushService: PushService,
    private readonly pushAlerts: PushAlertService,
  ) {}

  @Get('vapid-public-key')
  getVapidPublicKey() {
    return {
      publicKey: this.pushService.getPublicKey(),
      configured: this.pushService.isConfigured(),
    };
  }

  /**
   * Same-origin proxy for product thumbnails used in web push icons.
   * Public (no auth) so the OS / service worker can fetch the icon URL.
   */
  @Get('product-image')
  @Header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800')
  async productImage(
    @Query('url') url: string | undefined,
    @Res() res: Response,
  ) {
    const raw = String(url ?? '').trim();
    if (!raw || !isAllowedPushImageUrl(raw)) {
      res.status(400).send('Invalid image url');
      return;
    }
    try {
      const upstream = await fetch(raw, {
        headers: {
          'User-Agent': 'SellerBunkerPushIcon/1.0',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
        redirect: 'follow',
      });
      if (!upstream.ok) {
        res.status(502).send('Upstream image failed');
        return;
      }
      const contentType =
        upstream.headers.get('content-type') || 'image/jpeg';
      if (!contentType.startsWith('image/')) {
        res.status(502).send('Not an image');
        return;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', String(buf.length));
      res.send(buf);
    } catch {
      res.status(502).send('Image fetch error');
    }
  }

  /**
   * Sale notification card: product thumb + bright green £ amount (PNG).
   * Public so the OS can fetch it when rendering the push.
   */
  @Get('sale-card')
  @Header('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600')
  async saleCard(
    @Query('url') url: string | undefined,
    @Query('profit') profit: string | undefined,
    @Query('title') title: string | undefined,
    @Res() res: Response,
  ) {
    try {
      const profitLabel = String(profit ?? '').trim() || 'Sale';
      const imageUrl = String(url ?? '').trim() || null;
      if (imageUrl && !isAllowedPushImageUrl(imageUrl)) {
        res.status(400).send('Invalid image url');
        return;
      }
      const png = await renderSalePushCard({
        imageUrl,
        profitLabel,
        title: title ?? null,
      });
      if (!png) {
        res.status(502).send('Could not render card');
        return;
      }
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Length', String(png.length));
      res.send(png);
    } catch {
      res.status(502).send('Could not render card');
    }
  }

  /**
   * Square green-£ icon (legacy). Sale pushes must use sale-check-icon instead
   * so the £ amount is not painted into the notification icon.
   */
  @Get('sale-amount-icon')
  @Header('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600')
  async saleAmountIcon(
    @Query('profit') profit: string | undefined,
    @Res() res: Response,
  ) {
    try {
      const profitLabel = String(profit ?? '').trim() || 'Sale';
      const png = renderSalePushAmountIcon({ profitLabel });
      if (!png) {
        res.status(502).send('Could not render icon');
        return;
      }
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Length', String(png.length));
      res.send(png);
    } catch {
      res.status(502).send('Could not render icon');
    }
  }

  /**
   * Solid green check mark — no £ digits. Preferred sale notification icon.
   */
  @Get('sale-check-icon')
  @Header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800')
  async saleCheckIcon(@Res() res: Response) {
    try {
      const png = renderSalePushCheckIcon();
      if (!png) {
        res.status(502).send('Could not render icon');
        return;
      }
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Length', String(png.length));
      res.send(png);
    } catch {
      res.status(502).send('Could not render icon');
    }
  }

  @UseGuards(ClerkAuthGuard)
  @Post('subscribe')
  async subscribe(
    @Req() req: { user: { userId: string; orgId?: string } },
    @Body()
    body: {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
      userAgent?: string;
    },
  ) {
    const endpoint = String(body?.endpoint ?? '').trim();
    const p256dh = String(body?.keys?.p256dh ?? '').trim();
    const auth = String(body?.keys?.auth ?? '').trim();
    if (!endpoint || !p256dh || !auth) {
      return { ok: false, error: 'Missing subscription fields' };
    }
    await this.pushService.upsertSubscription({
      userId: req.user.userId,
      orgId: req.user.orgId ?? null,
      endpoint,
      p256dh,
      auth,
      userAgent: body.userAgent ?? null,
    });
    return { ok: true };
  }

  @UseGuards(ClerkAuthGuard)
  @Delete('subscribe')
  async unsubscribe(
    @Req() req: { user: { userId: string } },
    @Body() body: { endpoint?: string },
  ) {
    const endpoint = String(body?.endpoint ?? '').trim();
    if (!endpoint) return { ok: false, error: 'Missing endpoint' };
    await this.pushService.removeSubscription(req.user.userId, endpoint);
    return { ok: true };
  }

  /**
   * Schedule a reminder push (e.g. cancel free trial).
   * Tap opens `url` when set. Requires push enabled on the device.
   */
  @UseGuards(ClerkAuthGuard)
  @Post('alerts')
  async createAlert(
    @Req() req: { user: { userId: string } },
    @Body() body: CreatePushAlertDto,
  ) {
    return this.pushAlerts.createAlert(req.user.userId, {
      fireAt: body.fireAt,
      title: body.title,
      body: body.body,
      url: body.url,
    });
  }

  /**
   * Send a rich sample sale push to the signed-in user's registered devices.
   */
  @UseGuards(ClerkAuthGuard)
  @Post('test')
  async testPush(@Req() req: { user: { userId: string } }) {
    if (!this.pushService.isConfigured()) {
      return { ok: false, error: 'Push is not configured on the server' };
    }
    // Title carries £ once; body empty; green check icon (no baked-in £); no sale-card image.
    const texts = buildSalePushTexts({
      profitLabel: '£6.40 profit',
      shortTitle: 'Test product',
      quantity: 1,
    });
    const icon = toSaleCheckIconUrl();
    const payload = {
      title: texts.title,
      body: '',
      url: '/orders',
      tag: `test-${Date.now()}`,
      icon,
      badge: 'https://www.sellerbunker.com/favicon-48x48.png',
      color: '#10B981',
      profitLabel: texts.profitLabel,
    };
    const wireJson = JSON.stringify(payload);
    const hasTick =
      wireJson.includes('\u2705') && payload.title.includes('\u2705');
    const titleOk = /^Sold:\s+\d+\s+\u00d7\s+.+\s+\u2014\s+\u2705\s+/u.test(
      payload.title,
    );
    const bodyEmpty = payload.body === '';
    const noAmountIcon = !icon.includes('sale-amount-icon');
    const noSaleCard =
      !wireJson.includes('sale-card') && !('image' in payload);
    const poundInTitleOnly =
      (payload.title.match(/£/g) ?? []).length === 1 &&
      !payload.body.includes('£');
    const { sent } = await this.pushService.notifyUser(req.user.userId, payload);
    const checksOk =
      hasTick && titleOk && bodyEmpty && noAmountIcon && noSaleCard && poundInTitleOnly;
    return {
      ok: sent > 0 && checksOk,
      sent,
      hasTick,
      titleOk,
      bodyEmpty,
      noAmountIcon,
      noSaleCard,
      poundInTitleOnly,
      wireJson,
      payload: {
        title: payload.title,
        body: payload.body,
        icon: payload.icon,
        color: payload.color,
        profitLabel: payload.profitLabel,
      },
      error:
        sent > 0
          ? checksOk
            ? undefined
            : 'Wire payload must have Sold:…✅ title, empty body, check icon, no sale-card'
          : 'No push subscription saved for your account. Settings → Notifications → Enable alerts (Home Screen on iPhone).',
    };
  }
}
