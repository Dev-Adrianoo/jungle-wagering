import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { PrometheusMetrics } from '../../../infrastructure/observability/prometheus-metrics';
import { Public } from '../auth/decorators';
import { METRICS } from '../tokens';

@Public()
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: PrometheusMetrics) {}

  @Get()
  async scrape(@Res() response: Response): Promise<void> {
    response.setHeader('Content-Type', this.metrics.contentType);
    response.send(await this.metrics.render());
  }
}
