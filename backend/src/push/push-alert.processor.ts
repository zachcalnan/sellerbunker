import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  PUSH_ALERTS_QUEUE,
  PushAlertService,
  type PushAlertJobData,
} from './push-alert.service';

@Processor(PUSH_ALERTS_QUEUE)
export class PushAlertProcessor extends WorkerHost {
  private readonly logger = new Logger(PushAlertProcessor.name);

  constructor(private readonly pushAlerts: PushAlertService) {
    super();
  }

  async process(job: Job<PushAlertJobData>): Promise<void> {
    const alertId = String(job.data?.alertId ?? '').trim();
    const userId = String(job.data?.userId ?? '').trim();
    if (!alertId || !userId) {
      this.logger.warn(`Invalid push-alert job ${job.id}`);
      return;
    }
    await this.pushAlerts.deliverAlert(alertId, userId);
  }
}
