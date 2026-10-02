import 'reflect-metadata';
import { loadConfig } from './config/config';
import { createApp } from './interface/http/create-app';

const config = loadConfig();
const app = await createApp(config);
app.enableShutdownHooks();
await app.listen(config.port);
console.log(JSON.stringify({ level: 'info', message: 'listening', port: config.port }));
