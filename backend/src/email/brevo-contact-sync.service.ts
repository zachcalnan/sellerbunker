import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { UsersService } from '../users/users.service';

/**
 * Periodically upserts DB users missing brevoSyncedAt into Brevo (BREVO_SIGNUP_LIST_ID).
 * Also runs once shortly after boot so deploys pick up missed contacts.
 */
@Injectable()
export class BrevoContactSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BrevoContactSyncService.name);
  private interval: ReturnType<typeof setInterval> | null = null;
  private bootTimeout: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly usersService: UsersService) {}

  async onModuleInit(): Promise<void> {
    const enabled = (
      process.env.ENABLE_BREVO_CONTACT_SYNC_SCHEDULER ?? 'true'
    ).toLowerCase();
    if (!['1', 'true', 'yes', 'on'].includes(enabled)) {
      this.logger.log(
        'Brevo contact sync scheduler disabled (ENABLE_BREVO_CONTACT_SYNC_SCHEDULER=false)',
      );
      return;
    }
    if (!process.env.BREVO_API_KEY?.trim()) {
      this.logger.log('BREVO_API_KEY not set; skipping Brevo contact sync scheduler');
      return;
    }

    const everyMs =
      Number(process.env.BREVO_CONTACT_SYNC_EVERY_MS) || 6 * 60 * 60 * 1000;
    const bootDelayMs = Number(process.env.BREVO_CONTACT_SYNC_BOOT_DELAY_MS) || 60_000;

    this.bootTimeout = setTimeout(() => void this.runOnce('boot'), bootDelayMs);
    this.interval = setInterval(() => void this.runOnce('interval'), everyMs);
    this.logger.log(
      `Brevo contact sync scheduled (boot in ${bootDelayMs}ms, then every ${everyMs}ms)`,
    );
  }

  onModuleDestroy(): void {
    if (this.bootTimeout) clearTimeout(this.bootTimeout);
    if (this.interval) clearInterval(this.interval);
  }

  private async runOnce(trigger: string): Promise<void> {
    if (this.running) {
      this.logger.log(`Brevo contact sync skipped (${trigger}: already running)`);
      return;
    }
    this.running = true;
    try {
      const result = await this.usersService.syncPendingBrevoContacts();
      if (result.attempted > 0 || result.pending > 0) {
        this.logger.log(
          `Brevo contact sync (${trigger}): synced=${result.synced} attempted=${result.attempted} stillPending=${result.pending}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Brevo contact sync (${trigger}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.running = false;
    }
  }
}
