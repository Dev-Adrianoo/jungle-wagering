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
import { buildCore, type Core } from '../../composition/core';
import type { AppConfig } from '../../config/config';
import { buildOrmConfig } from '../../infrastructure/persistence/orm.config';
import { HealthController } from './controllers/health.controller';
import { APP_CONFIG, CORE } from './tokens';

@Injectable()
class OrmLifecycle implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}

@Module({})
class AppModule {}

export function registerAppModule(config: AppConfig): DynamicModule {
  return {
    module: AppModule,
    controllers: [HealthController],
    providers: [
      { provide: APP_CONFIG, useValue: config },
      {
        provide: MikroORM,
        useFactory: () => MikroORM.init(buildOrmConfig(config.databaseUrl)),
      },
      {
        provide: CORE,
        inject: [MikroORM],
        useFactory: (orm: MikroORM): Core =>
          buildCore(orm, { lockTimeoutMs: config.lockTimeoutMs }),
      },
      OrmLifecycle,
    ],
  };
}
