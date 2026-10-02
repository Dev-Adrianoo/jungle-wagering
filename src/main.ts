import 'reflect-metadata';
import type { Logger } from './application/ports/logger';
import { loadConfig } from './config/config';
import { createApp } from './interface/http/create-app';
import { LOGGER } from './interface/http/tokens';

const config = loadConfig();
const app = await createApp(config);
app.enableShutdownHooks();
await app.listen(config.port);
app.get<Logger>(LOGGER).info('app.listening', { port: config.port });
