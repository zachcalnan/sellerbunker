import { Controller, Get } from '@nestjs/common';
import { AmazonService } from './amazon.service';

@Controller('amazon')
export class AmazonController {
  constructor(private readonly amazonService: AmazonService) {}

  @Get('account/summary')
  getAccountSummary() {
    return this.amazonService.getAccountSummary();
  }

  @Get('sandbox/marketplaces')
  async getSandboxMarketplaces() {
    // Example endpoint that proxies the SP-API Sellers "getMarketplaceParticipations"
    // call (currently returns a static payload from AmazonSpApiClient).
    return this.amazonService.getSandboxMarketplaceParticipations();
  }

  @Get('sandbox/orders')
  async getRecentOrders() {
    // Example endpoint that proxies the SP-API Orders getOrders call.
    // Requires valid SP-API credentials in the backend environment.
    return this.amazonService.getRecentOrders();
  }
}