import { Body, Controller, Get, Patch, Post, UseGuards, Req } from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';
import { MarketplaceService } from './marketplace.service';

@Controller('marketplaces')
@UseGuards(ClerkAuthGuard)
export class MarketplaceController {
  constructor(private readonly marketplaceService: MarketplaceService) {}

  @Get('catalog')
  getCatalog() {
    return this.marketplaceService.getCatalog();
  }

  @Get()
  list(@Req() req: { user: { userId: string } }) {
    return this.marketplaceService.listUserMarketplaces(req.user.userId);
  }

  @Post('base')
  setBase(
    @Req() req: { user: { userId: string } },
    @Body() body: { marketplaceId: string },
  ) {
    return this.marketplaceService.setBaseMarketplace(
      req.user.userId,
      body.marketplaceId,
    );
  }

  @Post('detect-activity')
  detectActivity(@Req() req: { user: { userId: string } }) {
    return this.marketplaceService.detectMarketplaceActivity(req.user.userId);
  }

  @Patch('toggle')
  toggle(
    @Req() req: { user: { userId: string } },
    @Body() body: { marketplaceId: string; enabled: boolean },
  ) {
    return this.marketplaceService.toggleMarketplace(
      req.user.userId,
      body.marketplaceId,
      Boolean(body.enabled),
    );
  }
}
