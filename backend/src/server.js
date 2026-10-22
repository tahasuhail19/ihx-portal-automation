import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createBrowserlessClient } from './browser/browserless.js';
import { runIhxLogin } from './ihx/login.js';
import { createSessionManager } from './sessions/sessionManager.js';

const config = loadConfig();
const logger = createLogger();
const manager = createSessionManager({
  config,
  browserless: createBrowserlessClient(config),
  runLogin: runIhxLogin,
  logger,
});
const app = createApp(config, manager, logger);

const server = app.listen(config.port, config.bindHost, () => {
  logger.info('backend listening', {
    host: config.bindHost,
    port: config.port,
    loginMode: config.loginMode,
    browserlessConfigured: Boolean(config.browserlessToken),
    browserlessHost: config.browserlessHost,
    browserlessStealth: config.stealth,
    browserlessProxy: config.proxy || 'none',
    sessionTimeoutMs: config.sessionTimeoutMs,
    apiKeyRequired: Boolean(config.appApiKey),
  });
  if (!config.browserlessToken) {
    logger.info('BROWSERLESS_TOKEN is empty. Add it to the project root .env file and restart.');
  }
});

async function shutdown() {
  logger.info('backend shutting down');
  await manager.closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
