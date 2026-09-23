import { createApp } from './app.ts';
import { config } from './config.ts';
import { createLogger } from '@iron-ridge/util';

const log = createLogger('iron-ridge-api', config.LOG_LEVEL);
const app = createApp();

app.listen(config.PORT, () => {
  log.info({ port: config.PORT, env: config.NODE_ENV }, 'server started');
});
