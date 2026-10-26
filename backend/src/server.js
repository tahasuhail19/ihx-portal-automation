import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createDesktopBrowser } from './browser/desktop.js';
import { runIhxLogin } from './ihx/login.js';
import { createSessionManager } from './sessions/sessionManager.js';
import { createEmailOtpClient, fetchEmailOtp } from './integrations/emailOtp.js';
import { loadIhxCredentials } from './integrations/ihxCase.js';
import { createRpaClient } from './integrations/rpaClient.js';

const config = loadConfig();
const logger = createLogger();
const rpaClient = config.rpaEnabled ? createRpaClient({ logger }) : null;
const emailClient = config.emailOtpEnabled ? createEmailOtpClient() : null;
const manager = createSessionManager({
  config,
  desktop: createDesktopBrowser(config, logger),
  runLogin: runIhxLogin,
  loadCase: rpaClient ? () => loadIhxCredentials(rpaClient, logger) : null,
  readEmailOtp: emailClient
    ? (options = {}) => fetchEmailOtp(config.emailOtpFrom, { ...options, client: emailClient, logger })
    : null,
  logger,
});
const app = createApp(config, manager, logger);

const server = app.listen(config.port, config.bindHost, () => {
  logger.info('backend listening', {
    host: config.bindHost,
    port: config.port,
    loginMode: config.loginMode,
    viewer: 'novnc',
    display: config.display,
    sessionTimeoutMs: config.sessionTimeoutMs,
    caseApi: config.rpaEnabled,
    emailOtp: config.emailOtpEnabled,
    apiKeyRequired: Boolean(config.appApiKey),
  });
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
