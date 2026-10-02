// NestJS lives only at this edge. Use cases and repositories are built by buildCore and
// exposed through the CORE token, so the application layer has no framework decorators.
import { MikroORM } from '@mikro-orm/postgresql';
import {
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Logger } from '../../application/ports/logger';
import type { ProviderIdentityPort } from '../../application/ports/provider-identity-port';
import { buildCore, type Core } from '../../composition/core';
import type { AppConfig } from '../../config/config';
import { NoopIdentityAdapter } from '../../infrastructure/auth/noop-identity-adapter';
import { PinoLogger } from '../../infrastructure/observability/pino-logger';
import { PrometheusMetrics } from '../../infrastructure/observability/prometheus-metrics';
import { buildOrmConfig } from '../../infrastructure/persistence/orm.config';
import { AuthGuard } from './auth/auth.guard';
import { HealthController } from './controllers/health.controller';
import { MetricsController } from './controllers/metrics.controller';
import { WageringController } from './controllers/wagering.controller';
import { WalletsController } from './controllers/wallets.controller';
import { APP_CONFIG, CORE, LOGGER, METRICS, PROVIDER_IDENTITY_PORT } from './tokens';

@Injectable()
class OrmLifecycle implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}

@Module({})
class AppModule {}

export interface AppOverrides {
  identityPort?: ProviderIdentityPort;
  logger?: Logger;
}

export function registerAppModule(config: AppConfig, overrides: AppOverrides = {}): DynamicModule {
  return {
    module: AppModule,
    controllers: [HealthController, WalletsController, WageringController, MetricsController],
    providers: [
      { provide: APP_CONFIG, useValue: config },
      { provide: LOGGER, useValue: overrides.logger ?? new PinoLogger(config.logLevel) },
      { provide: METRICS, useValue: new PrometheusMetrics() },
      {
        provide: MikroORM,
        useFactory: () => MikroORM.init(buildOrmConfig(config.databaseUrl)),
      },
      {
        provide: CORE,
        inject: [MikroORM, LOGGER, METRICS],
        useFactory: (orm: MikroORM, logger: Logger, metrics: PrometheusMetrics): Core =>
          buildCore(orm, { lockTimeoutMs: config.lockTimeoutMs, logger, metrics }),
      },
      {
        provide: PROVIDER_IDENTITY_PORT,
        useValue: overrides.identityPort ?? new NoopIdentityAdapter(),
      },
      { provide: APP_GUARD, useClass: AuthGuard },
      OrmLifecycle,
    ],
  };
}
