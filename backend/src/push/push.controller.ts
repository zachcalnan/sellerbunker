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
import { isAllowedPushImageUrl, toPushIconUrl, toSaleCardUrl } from './push-image.util';
import { renderSalePushCard } from './sale-push-card.util';

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
   * Sale notification card: product thumb + emerald profit (PNG).
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
    // Sample Amazon product thumb + emerald profit card.
    const sampleAmazon =
      'https://m.media-amazon.com/images/I/41VCNSoEWeL.jpg';
    const icon =
      toPushIconUrl(sampleAmazon) ??
      'https://www.sellerbunker.com/icon-192.png';
    const card = toSaleCardUrl({
      imageUrl: sampleAmazon,
      profitLabel: '£6.40 profit',
      title: 'Test product',
    });
    const { sent } = await this.pushService.notifyUser(req.user.userId, {
      title: 'Test product',
      body: '£6.40 profit',
      url: '/orders',
      tag: `test-${Date.now()}`,
      icon,
      image: card,
      badge: 'https://www.sellerbunker.com/favicon-48x48.png',
      profitLabel: '£6.40 profit',
    });
    return {
      ok: sent > 0,
      sent,
      error:
        sent > 0
          ? undefined
          : 'No push subscription saved for your account. Settings → Notifications → Enable alerts (Home Screen on iPhone).',
    };
  }
}
