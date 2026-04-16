import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';
import { UsersService } from '../users/users.service';
import { UpdateVatSettingsDto } from './dto/update-vat-settings.dto';
import { UpdateFixedCostsDto } from './dto/update-fixed-costs.dto';

@Controller('orgs')
export class OrgsController {
  constructor(private readonly usersService: UsersService) {}

  @UseGuards(ClerkAuthGuard)
  @Get('vat-settings')
  async getVatSettings(@Req() req: { user: { userId: string; orgId: string } }) {
    return this.usersService.getOrgVatSettings(req.user.orgId, req.user.userId);
  }

  @UseGuards(ClerkAuthGuard)
  @Patch('vat-settings')
  async updateVatSettings(
    @Req() req: { user: { userId: string; orgId: string } },
    @Body() dto: UpdateVatSettingsDto,
  ) {
    return this.usersService.updateOrgVatSettings(req.user.orgId, req.user.userId, {
      vatRegistrationType: dto.vatRegistrationType,
      vatEffectiveDate: dto.vatEffectiveDate,
      vatFlatRatePct: dto.vatFlatRatePct,
      vatRatePct: dto.vatRatePct,
      vatCostsIncludeVat: dto.vatCostsIncludeVat,
    });
  }

  @UseGuards(ClerkAuthGuard)
  @Get('fixed-costs')
  async getFixedCosts(@Req() req: { user: { userId: string; orgId: string } }) {
    return this.usersService.getOrgFixedCosts(req.user.orgId, req.user.userId);
  }

  @UseGuards(ClerkAuthGuard)
  @Patch('fixed-costs')
  async updateFixedCosts(
    @Req() req: { user: { userId: string; orgId: string } },
    @Body() dto: UpdateFixedCostsDto,
  ) {
    return this.usersService.updateOrgFixedCosts(req.user.orgId, req.user.userId, {
      softwareCosts: dto.softwareCosts,
      softwareCostItems: (dto as any).softwareCostItems,
      otherSubscriptions: dto.otherSubscriptions,
      otherSubscriptionItems: (dto as any).otherSubscriptionItems,
      otherFixedCosts: dto.otherFixedCosts,
      otherFixedCostItems: (dto as any).otherFixedCostItems,
    });
  }

  @UseGuards(ClerkAuthGuard)
  @Get()
  async list(@Req() req: { user: { userId: string } }) {
    return this.usersService.listOrgsForUser(req.user.userId);
  }

  /**
   * Dev-only helper: add an existing internal userId to the caller's active org.
   * This is useful when you have multiple Clerk accounts and want to unify data
   * without having access to the other account right now.
   */
  @UseGuards(ClerkAuthGuard)
  @Post('dev/add-member')
  async devAddMember(
    @Req() req: { user: { userId: string; orgId: string } },
    @Body() body: { userId: string },
  ) {
    const memberUserId = String((body as any)?.userId ?? '').trim();
    if (!memberUserId) {
      throw new BadRequestException('userId is required');
    }

    const isOwner = await this.usersService.isOrgOwner(
      req.user.userId,
      req.user.orgId,
    );
    if (!isOwner) {
      throw new BadRequestException('Only org owners can add members');
    }

    await this.usersService.addMemberToOrg(
      req.user.orgId,
      memberUserId,
      'member',
    );
    return { status: 'added', orgId: req.user.orgId, userId: memberUserId };
  }

  @UseGuards(ClerkAuthGuard)
  @Post('active')
  async setActive(
    @Req() req: { user: { userId: string } },
    @Body() body: { orgId: string },
  ) {
    const orgId = String((body as any)?.orgId ?? '').trim();
    if (!orgId) {
      throw new BadRequestException('orgId is required');
    }
    return this.usersService.setActiveOrg(req.user.userId, orgId);
  }
}
