import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  Req,
  Param,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';
import { RepricerService } from './repricer.service';

@Controller('repricer')
@UseGuards(ClerkAuthGuard)
export class RepricerController {
  constructor(private readonly repricer: RepricerService) {}

  @Get('ping')
  async ping() {
    return { ok: true };
  }

  @Get('candidates')
  async candidates(
    @Req() req: { user: { orgId: string } },
    @Res({ passthrough: true }) res: Response,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('q') q?: string,
  ) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return this.repricer.listCandidates(req.user.orgId, {
      page: page != null ? Number(page) : undefined,
      pageSize: pageSize != null ? Number(pageSize) : undefined,
      q: q ?? undefined,
    });
  }

  @Get('selected')
  async selected(@Req() req: { user: { orgId: string } }) {
    return this.repricer.getSelectedSkus(req.user.orgId);
  }

  @Get('logs')
  async logs(
    @Req() req: { user: { orgId: string } },
    @Query('productId') productId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.repricer.listLogs(req.user.orgId, productId, Number(limit) || 200);
  }

  @Get('rules')
  async rules(@Req() req: { user: { orgId: string } }) {
    return this.repricer.getRuleLibrary(req.user.orgId);
  }

  @Get('set-selected')
  async setSelected(
    @Req() req: { user: { orgId: string } },
    @Query('productIds') productIdsRaw?: string,
  ) {
    const productIds = (productIdsRaw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      return await this.repricer.setSelectedSkus(req.user.orgId, productIds);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e));
    }
  }

  @Get('set-rules')
  async setRules(
    @Req() req: { user: { orgId: string } },
    @Query('name') name?: string,
  ) {
    return this.repricer.upsertRuleSet(req.user.orgId, { name });
  }

  // JSON APIs (frontend uses these)
  @Post('selected')
  async setSelectedPost(
    @Req() req: { user: { orgId: string } },
    @Body() body: { productIds?: string[] },
  ) {
    const productIds = Array.isArray(body?.productIds) ? body.productIds : [];
    try {
      return await this.repricer.setSelectedSkus(req.user.orgId, productIds);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e));
    }
  }

  /** Assign one SKU to a saved pricing preset. */
  @Post('assign-sku')
  async assignSku(
    @Req() req: { user: { orgId: string } },
    @Body() body: { productId?: string; ruleSetId?: string },
  ) {
    return this.repricer.assignSkuToPreset(
      req.user.orgId,
      typeof body?.productId === 'string' ? body.productId : '',
      typeof body?.ruleSetId === 'string' ? body.ruleSetId : '',
    );
  }

  /** Remove a pricing rule assignment from one SKU (keeps SKU in selected list). */
  @Post('unassign-sku')
  async unassignSku(
    @Req() req: { user: { orgId: string } },
    @Body() body: { productId?: string },
  ) {
    return this.repricer.unassignSkuFromPreset(
      req.user.orgId,
      typeof body?.productId === 'string' ? body.productId : '',
    );
  }

  @Post('rules/apply')
  async applyRulePreset(
    @Req() req: { user: { orgId: string } },
    @Body() body: { presetId?: string },
  ) {
    const id = typeof body?.presetId === 'string' ? body.presetId.trim() : '';
    if (!id) throw new BadRequestException('presetId is required');
    return this.repricer.applyRulePreset(req.user.orgId, id);
  }

  @Post('rules')
  async setRulesPost(@Req() req: { user: { orgId: string } }, @Body() body: Record<string, unknown>) {
    try {
      return await this.repricer.saveRuleSet(req.user.orgId, (body ?? {}) as any);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e));
    }
  }

  @Delete('rules/:presetId')
  async deleteRulePreset(
    @Req() req: { user: { orgId: string } },
    @Param('presetId') presetId: string,
  ) {
    const id = typeof presetId === 'string' ? presetId.trim() : '';
    if (!id) throw new BadRequestException('presetId is required');
    return this.repricer.deleteRulePreset(req.user.orgId, id);
  }
}

