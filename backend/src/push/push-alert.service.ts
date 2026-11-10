import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from './push.service';

export const PUSH_ALERTS_QUEUE = 'push-alerts';

export type PushAlertJobData = {
  alertId: string;
  userId: string;
};

@Injectable()
export class PushAlertService {
  private readonly logger = new Logger(PushAlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushService: PushService,
    @InjectQueue(PUSH_ALERTS_QUEUE) private readonly queue: Queue,
  ) {}

  async createAlert(
    userId: string,
    input: { fireAt: Date; title: string; body: string; url?: string | null },
  ) {
    if (!this.pushService.isConfigured()) {
      throw new ServiceUnavailableException(
        'Push is not configured on the server',
      );
    }
    const fireAt =
      input.fireAt instanceof Date ? input.fireAt : new Date(input.fireAt);
    if (Number.isNaN(fireAt.getTime())) {
      throw new BadRequestException('fireAt must be a valid datetime');
    }
    const delayMs = fireAt.getTime() - Date.now();
    if (delayMs < 30_000) {
      throw new BadRequestException(
        'Alert time must be at least 30 seconds in the future',
      );
    }
    // Cap ~90 days out
    if (delayMs > 90 * 24 * 60 * 60 * 1000) {
      throw new BadRequestException('Alert time must be within 90 days');
    }

    const title = String(input.title ?? '').trim() || 'Reminder';
    const body = String(input.body ?? '').trim();
    if (!body) throw new BadRequestException('body (note) is required');
    let url = String(input.url ?? '').trim() || null;
    if (url && !/^https?:\/\//i.test(url)) {
      throw new BadRequestException('url must start with http:// or https://');
    }

    const alert = await this.prisma.pushAlert.create({
      data: {
        userId,
        fireAt,
        title: title.slice(0, 120),
        body: body.slice(0, 500),
        url,
        status: 'pending',
      },
    });

    const job = await this.queue.add(
      'fire',
      { alertId: alert.id, userId } satisfies PushAlertJobData,
      {
        jobId: `push-alert:${alert.id}`,
        delay: delayMs,
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
      },
    );

    await this.prisma.pushAlert.update({
      where: { id: alert.id },
      data: { jobId: String(job.id ?? '') || null },
    });

    this.logger.log(
      `Scheduled push alert ${alert.id} for user ${userId} at ${fireAt.toISOString()} (delay ${Math.round(delayMs / 1000)}s)`,
    );

    return {
      id: alert.id,
      fireAt: alert.fireAt.toISOString(),
      title: alert.title,
      body: alert.body,
      url: alert.url,
      status: alert.status,
    };
  }

  async deliverAlert(alertId: string, userId: string): Promise<void> {
    const alert = await this.prisma.pushAlert.findFirst({
      where: { id: alertId, userId },
    });
    if (!alert) {
      this.logger.warn(`Push alert missing ${alertId}`);
      return;
    }
    if (alert.status !== 'pending') {
      this.logger.log(`Push alert ${alertId} already ${alert.status}; skip`);
      return;
    }

    const { sent } = await this.pushService.notifyUser(userId, {
      title: alert.title,
      body: alert.body,
      url: alert.url || '/replenish',
      tag: `push-alert-${alert.id}`,
      icon: 'https://www.sellerbunker.com/icon-192.png',
      badge: 'https://www.sellerbunker.com/favicon-48x48.png',
    });

    await this.prisma.pushAlert.update({
      where: { id: alert.id },
      data: {
        status: sent > 0 ? 'sent' : 'failed',
        sentAt: new Date(),
      },
    });

    if (sent === 0) {
      this.logger.warn(
        `Push alert ${alert.id} delivered to 0 devices (enable alerts in Settings)`,
      );
    } else {
      this.logger.log(`Push alert ${alert.id} sent=${sent}`);
    }
  }
}
