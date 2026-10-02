import { MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/decorators';

@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const postgresUp = await this.isPostgresReachable();
    if (!postgresUp) {
      response.status(503);
    }
    return {
      status: postgresUp ? 'ok' : 'unavailable',
      checks: { postgres: postgresUp ? 'up' : 'down' },
    };
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
