import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Logger } from '../../application/ports/logger';
import type { AppConfig } from '../../config/config';
import { type AppOverrides, registerAppModule } from './app.module';
import { correlationMiddleware } from './correlation';
import { ProblemDetailsFilter } from './problem-details.filter';
import { LOGGER } from './tokens';

export async function createApp(
  config: AppConfig,
  overrides: AppOverrides = {},
): Promise<INestApplication> {
  const app = await NestFactory.create(registerAppModule(config, overrides), {
    logger: ['error', 'warn'],
  });
  const logger = app.get<Logger>(LOGGER);
  app.use(correlationMiddleware(logger));
  app.useGlobalFilters(new ProblemDetailsFilter(logger));
  return app;
}
