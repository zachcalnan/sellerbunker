import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AmazonService } from './amazon.service';
import { LinkAmazonAccountDto } from './dto/link-amazon-account.dto';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';

@UseGuards(ClerkAuthGuard)
@Controller('amazon')
export class AmazonController {
  constructor(private readonly amazonService: AmazonService) {}

  @Post('link')
  linkAmazonAccount(
    @Req() req: { user: { userId: string } },
    @Body() dto: LinkAmazonAccountDto,
  ) {
    return this.amazonService.linkAmazonAccount(req.user.userId, dto);
  }

  @Get('account/summary')
  getAccountSummary(@Req() req: { user: { userId: string } }) {
    return this.amazonService.getAccountSummary(req.user.userId);
  }

  @Get('sandbox/marketplaces')
  async getSandboxMarketplaces(@Req() req: { user: { userId: string } }) {
    // Example endpoint that proxies the SP-API Sellers "getMarketplaceParticipations"
    // call (currently returns a static payload from AmazonSpApiClient).
    return this.amazonService.getSandboxMarketplaceParticipations(
      req.user.userId,
    );
  }

  // NOTE: sandbox/orders is temporarily disabled until wired for
  // per-user credentials. You can re-enable it later if needed.
}