import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { buildConnectionUrl, createBrowserlessClient } from './browser/browserless.js';
import { assertPortalConfigured, runIhxLogin } from './ihx/login.js';
import { redact } from './redact.js';
import { createSessionManager } from './sessions/sessionManager.js';

const silent = { info() {}, error() {} };

const loaded = loadConfig();
assert.equal(typeof loaded.browserlessToken, 'string');
assert.ok(loaded.loginMode === 'test' || loaded.loginMode === 'portal');
assert.equal(typeof loaded.sessionTimeoutMs, 'number');

const plainUrl = new URL(buildConnectionUrl({
  token: 'secret-token',
  host: 'production-sfo.browserless.io',
  timeoutMs: 120000,
  stealth: false,
}));
assert.equal(plainUrl.protocol, 'wss:');
assert.equal(plainUrl.hostname, 'production-sfo.browserless.io');
assert.equal(plainUrl.pathname, '/chromium');
assert.equal(plainUrl.searchParams.get('token'), 'secret-token');
assert.equal(plainUrl.searchParams.get('timeout'), '120000');
assert.deepEqual([...plainUrl.searchParams.keys()].sort(), ['timeout', 'token']);

const stealthUrl = new URL(buildConnectionUrl({
  token: 'secret-token',
  host: 'production-lon.browserless.io',
  timeoutMs: 120000,
  stealth: true,
}));
assert.equal(stealthUrl.pathname, '/chromium/stealth');
assert.deepEqual([...stealthUrl.searchParams.keys()].sort(), ['timeout', 'token']);

const proxyUrl = new URL(buildConnectionUrl({
  token: 'secret-token',
  host: 'production-lon.browserless.io',
  timeoutMs: 120000,
  stealth: true,
  proxy: 'residential',
  proxyCountry: 'in',
}));
assert.equal(proxyUrl.pathname, '/chromium/stealth');
assert.equal(proxyUrl.searchParams.get('proxy'), 'residential');
assert.equal(proxyUrl.searchParams.get('proxyCountry'), 'in');
assert.equal(proxyUrl.searchParams.get('proxySticky'), 'true');
assert.equal('token' in Object.fromEntries(proxyUrl.searchParams) && proxyUrl.searchParams.get('token'), 'secret-token');

assert.equal(
  redact('failed wss://production-sfo.browserless.io/chromium?token=secret&timeout=1 password=hunter2'),
  'failed [redacted] [redacted]',
);

assert.throws(
  () => assertPortalConfigured({
    portalUrl: '',
    username: '',
    password: 'do-not-log',
    selectors: {},
  }),
  (error) => error.status === 400 && !error.message.includes('do-not-log'),
);

const testPage = {
  visited: '',
  async goto(url) {
    this.visited = url;
  },
  locator() {
    throw new Error('test mode must not fill or click a login form');
  },
};
const testLogin = await runIhxLogin({
  page: testPage,
  config: { loginMode: 'test', testPageUrl: 'https://httpbin.org/forms/post' },
  onState: async (state) => {
    assert.equal(state, 'LOGGING_IN');
  },
});
assert.equal(testLogin.outcome, 'ready');
assert.equal(testPage.visited, 'https://httpbin.org/forms/post');

assert.doesNotThrow(() => assertPortalConfigured({
  portalUrl: 'https://provider.ihx.in/',
  username: 'user@example.com',
  password: 'secret',
  selectors: {},
}));

await assert.rejects(
  () => runIhxLogin({
    page: {
      goto() {
        throw new Error('portal mode must not navigate without selectors');
      },
    },
    config: {
      loginMode: 'portal',
      portalUrl: '',
      username: '',
      password: '',
      selectors: {},
    },
    onState: async () => {},
  }),
  (error) => error.status === 400,
);

const client = createBrowserlessClient({
  browserlessToken: 'secret-token',
  browserlessHost: 'production-sfo.browserless.io',
  sessionTimeoutMs: 120000,
  stealth: false,
});
await assert.rejects(
  () => client.mintLiveUrl({
    async send() {
      return {
        error: null,
        liveURL: 'https://production-sfo.browserless.io/live/index.html?token=secret-token',
        liveURLId: 'live-1',
      };
    },
  }, { timeout: 1000 }),
  /API token/,
);

const { calls, cdp, browserless } = fakeBrowserless();
const manager = createSessionManager({
  config: baseConfig(),
  browserless,
  runLogin: async ({ onState }) => {
    await onState('LOGGING_IN', 'Opening the public test page.');
    return { outcome: 'ready', message: 'The public test page is open.' };
  },
  logger: silent,
});

const created = manager.create();
assert.equal(created.state, 'STARTING');
assert.equal(created.liveUrl, null);
assert.equal(typeof created.sessionToken, 'string');
assert.equal(created.sessionToken.length, 64);
assert.doesNotMatch(JSON.stringify(created), /secret-token|wss:\/\//);

const ready = await waitFor(() => {
  const view = manager.get(created.id, created.sessionToken);
  return view.state === 'READY_FOR_DOCTOR' ? view : null;
});
assert.equal(ready.liveUrl, 'https://production-sfo.browserless.io/live/index.html?i=viewer');
assert.equal(ready.sessionToken, undefined);
assert.doesNotMatch(JSON.stringify(ready), /secret-token|wss:\/\//);

const minted = calls.find((call) => call.method === 'Browserless.liveURL');
assert.equal(minted.params.interactable, true);
assert.equal(minted.params.resizable, true);
assert.equal(minted.params.showBrowserInterface, false);
assert.equal(minted.params.quality, 20);
assert.equal(minted.params.mode, 'follow');
assert.equal(minted.params.instructions.layout, 'panel');
assert.equal(minted.params.doneLabel, 'Finish session');
assert.equal('token' in minted.params, false);
assert.ok(Number.isInteger(minted.params.timeout));
assert.ok(minted.params.timeout > 0);
assert.ok(minted.params.timeout <= 120000);

cdp.handlers['Browserless.liveComplete']({
  reason: 'viewerDisconnected',
  liveURLId: 'live-1',
});
await delay(30);
assert.equal(manager.get(created.id, created.sessionToken).state, 'READY_FOR_DOCTOR');

assert.throws(() => manager.get(created.id, 'wrong-token'), (error) => error.status === 404);
assert.throws(() => manager.get(created.id, ''), (error) => error.status === 404);
assert.throws(
  () => manager.create(),
  (error) => error.status === 409,
);

cdp.handlers['Browserless.liveComplete']({
  reason: 'userFailed',
  liveURLId: 'live-1',
  feedback: { category: 'other', message: 'secret patient details' },
});
const failed = await waitFor(() => {
  const view = manager.get(created.id, created.sessionToken);
  return view.state === 'FAILED' ? view : null;
});
assert.equal(failed.liveUrl, null);
assert.doesNotMatch(JSON.stringify(failed), /secret patient details/);
await waitFor(() => calls.some((call) => call.method === 'browser.close'));

const second = manager.create();
await waitFor(() => manager.get(second.id, second.sessionToken).state === 'READY_FOR_DOCTOR');
cdp.handlers['Browserless.liveComplete']({ reason: 'userDone', liveURLId: 'live-1' });
const closed = await waitFor(() => {
  const view = manager.get(second.id, second.sessionToken);
  return view.state === 'CLOSED' ? view : null;
});
assert.equal(closed.liveUrl, null);
const again = await manager.finish(second.id, second.sessionToken);
assert.equal(again.state, 'CLOSED');

const third = manager.create();
await waitFor(() => manager.get(third.id, third.sessionToken).state === 'READY_FOR_DOCTOR');
const finished = await manager.finish(third.id, third.sessionToken);
assert.equal(finished.state, 'CLOSED');
assert.equal(manager.activeCount(), 0);

const blocked = createSessionManager({
  config: { ...baseConfig(), loginMode: 'portal', portalUrl: '', username: '', password: '', selectors: {} },
  browserless: {
    async connect() {
      throw new Error('should not connect');
    },
  },
  runLogin: async () => {
    throw new Error('should not login');
  },
  logger: silent,
});
assert.throws(() => blocked.create(), (error) => error.status === 400);

const unconfigured = createSessionManager({
  config: { ...baseConfig(), browserlessToken: '' },
  browserless: {
    async connect() {
      throw new Error('should not connect');
    },
  },
  runLogin: async () => {
    throw new Error('should not login');
  },
  logger: silent,
});
assert.throws(() => unconfigured.create(), (error) => error.status === 503);

const httpConfig = {
  ...baseConfig(),
  browserlessToken: '',
  browserlessHost: 'production-sfo.browserless.io',
  browserlessOrigin: 'https://production-sfo.browserless.io',
  knownCloudRegion: true,
  appApiKey: 'local-key',
  corsOrigins: ['http://127.0.0.1:5173'],
  maxActiveSessions: 1,
};
const httpManager = createSessionManager({
  config: httpConfig,
  browserless: {
    async connect() {
      throw new Error('should not connect');
    },
  },
  runLogin: async () => {
    throw new Error('should not login');
  },
  logger: silent,
});
const server = createApp(httpConfig, httpManager, silent).listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
try {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.browserlessConfigured, false);
  assert.equal(healthBody.ok, true);
  assert.equal(JSON.stringify(healthBody).includes('local-key'), false);

  const missingKey = await fetch(`${base}/api/ihx/session`, { method: 'POST' });
  assert.equal(missingKey.status, 401);

  const missingToken = await fetch(`${base}/api/ihx/session`, {
    method: 'POST',
    headers: { 'X-Api-Key': 'local-key' },
  });
  assert.equal(missingToken.status, 503);
  const missingBody = await missingToken.json();
  assert.match(missingBody.error, /BROWSERLESS_TOKEN/);

  const missingSession = await fetch(`${base}/api/ihx/session/not-a-session`, {
    headers: { 'X-Api-Key': 'local-key' },
  });
  assert.equal(missingSession.status, 404);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

const routeBrowser = fakeBrowserless();
const routeConfig = {
  ...baseConfig(),
  browserlessHost: 'production-sfo.browserless.io',
  browserlessOrigin: 'https://production-sfo.browserless.io',
  knownCloudRegion: true,
  appApiKey: '',
  corsOrigins: ['http://127.0.0.1:5173'],
};
const routeManager = createSessionManager({
  config: routeConfig,
  browserless: routeBrowser.browserless,
  runLogin: async ({ onState }) => {
    await onState('LOGGING_IN', 'Opening the public test page.');
    return { outcome: 'ready', message: 'The public test page is open.' };
  },
  logger: silent,
});
const routeServer = createApp(routeConfig, routeManager, silent).listen(0, '127.0.0.1');
await new Promise((resolve) => routeServer.once('listening', resolve));
try {
  const port = routeServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  const createdResponse = await fetch(`${base}/api/ihx/session`, { method: 'POST' });
  assert.equal(createdResponse.status, 201);
  const createdBody = await createdResponse.json();
  assert.equal(createdBody.state, 'STARTING');
  assert.equal(createdBody.liveUrl, null);
  assert.doesNotMatch(JSON.stringify(createdBody), /secret-token|wss:\/\//);

  const unauthorized = await fetch(`${base}/api/ihx/session/${createdBody.id}`);
  assert.equal(unauthorized.status, 404);

  const authorized = await fetch(`${base}/api/ihx/session/${createdBody.id}`, {
    headers: { 'X-Session-Token': createdBody.sessionToken },
  });
  assert.equal(authorized.status, 200);

  const finishedResponse = await fetch(`${base}/api/ihx/session/${createdBody.id}/finish`, {
    method: 'POST',
    headers: { 'X-Session-Token': createdBody.sessionToken },
  });
  assert.equal(finishedResponse.status, 200);
  const finishedBody = await finishedResponse.json();
  assert.equal(finishedBody.state, 'CLOSED');
  assert.equal(finishedBody.liveUrl, null);
  assert.equal(JSON.stringify(finishedBody).includes(createdBody.sessionToken), false);
} finally {
  await routeManager.closeAll();
  await new Promise((resolve) => routeServer.close(resolve));
}

console.log('self-check passed');

function baseConfig() {
  return {
    browserlessToken: 'secret-token',
    loginMode: 'test',
    sessionTimeoutMs: 120000,
    maxActiveSessions: 1,
    selectors: { success: '#ready' },
  };
}

function fakeBrowserless() {
  const calls = [];
  const cdp = {
    handlers: {},
    async send(method, params) {
      calls.push({ method, params });
      if (method === 'Browserless.liveURL') {
        return {
          error: null,
          liveURL: 'https://production-sfo.browserless.io/live/index.html?i=viewer',
          liveURLId: 'live-1',
          timeout: params.timeout,
        };
      }
      if (method === 'Browserless.closeLiveURL' || method === 'Browserless.setLiveURLInstructions') {
        return { error: null, liveURLId: params.liveURLId };
      }
      throw new Error(`unexpected ${method}`);
    },
    on(event, handler) {
      this.handlers[event] = handler;
    },
  };
  const browserless = {
    async connect() {
      calls.push({ method: 'connect' });
      return {
        browser: {
          on() {},
          async close() {
            calls.push({ method: 'browser.close' });
          },
        },
        context: {},
        page: {},
      };
    },
    async openCdp() {
      return cdp;
    },
    async mintLiveUrl(sessionCdp, options) {
      const result = await sessionCdp.send('Browserless.liveURL', options);
      if (result?.error) throw new Error(result.error);
      if (String(result.liveURL).includes('token=')) {
        throw new Error('Refusing to share a live URL that contains an API token.');
      }
      return result;
    },
    async replaceInstructions(sessionCdp, liveURLId, instructions, doneLabel) {
      await sessionCdp.send('Browserless.setLiveURLInstructions', { liveURLId, instructions, doneLabel });
    },
    async closeLiveUrl(sessionCdp, liveURLId) {
      if (!sessionCdp || !liveURLId) return;
      await sessionCdp.send('Browserless.closeLiveURL', { liveURLId });
    },
  };
  return { calls, cdp, browserless };
}

async function waitFor(read) {
  const started = Date.now();
  while (Date.now() - started < 2000) {
    const value = read();
    if (value) return value;
    await delay(10);
  }
  throw new Error('timed out waiting for session state');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
