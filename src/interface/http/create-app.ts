import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AppConfig } from '../../config/config';
import { type AppOverrides, registerAppModule } from './app.module';
import { correlationMiddleware } from './correlation';
import { ProblemDetailsFilter } from './problem-details.filter';

export async function createApp(
  config: AppConfig,
  overrides: AppOverrides = {},
): Promise<INestApplication> {
  const app = await NestFactory.create(registerAppModule(config, overrides), {
    logger: ['error', 'warn'],
  });
  app.use(correlationMiddleware);
  app.useGlobalFilters(new ProblemDetailsFilter());
  return app;
}
