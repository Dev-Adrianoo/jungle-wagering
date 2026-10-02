import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { QueueUrls } from '../../../infrastructure/sqs/queues';
import { Public } from '../auth/decorators';
import { QUEUE_URLS, SQS_CLIENT } from '../tokens';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(QUEUE_URLS) private readonly queueUrls: QueueUrls,
  ) {}

  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const [postgresUp, sqsUp] = await Promise.all([
      this.isPostgresReachable(),
      this.isSqsReachable(),
    ]);
    const ready = postgresUp && sqsUp;
    if (!ready) {
      response.status(503);
    }
    return {
      status: ready ? 'ok' : 'unavailable',
      checks: { postgres: postgresUp ? 'up' : 'down', sqs: sqsUp ? 'up' : 'down' },
    };
  }

  private async isSqsReachable(): Promise<boolean> {
    try {
      await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.queueUrls.transactions,
          AttributeNames: ['QueueArn'],
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  private async isPostgresReachable(): Promise<boolean> {
    try {
      await this.orm.em.fork().getConnection().execute('select 1');
      return true;
    } catch {
      return false;
    }
  }
}
