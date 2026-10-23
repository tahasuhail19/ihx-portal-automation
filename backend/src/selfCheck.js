import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { buildViewerUrl } from './browser/desktop.js';
import { assertPortalConfigured, runIhxLogin } from './ihx/login.js';
import { redact } from './redact.js';
import { createSessionManager } from './sessions/sessionManager.js';

const silent = { info() {}, error() {} };
const viewerUrl = 'http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale';

const loaded = loadConfig();
assert.ok(loaded.loginMode === 'test' || loaded.loginMode === 'portal');
assert.equal(typeof loaded.sessionTimeoutMs, 'number');
assert.equal(typeof loaded.viewerUrl, 'string');
assert.doesNotMatch(loaded.viewerUrl, /token=|password=/i);

assert.equal(buildViewerUrl(viewerUrl), viewerUrl);
assert.throws(() => buildViewerUrl('http://127.0.0.1:6080/vnc.html?token=secret'), /token or password/);

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

const calls = [];
const manager = createSessionManager({
  config: baseConfig(),
  desktop: fakeDesktop(calls),
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
assert.equal(ready.liveUrl, viewerUrl);
assert.equal(ready.sessionToken, undefined);
assert.doesNotMatch(JSON.stringify(ready), /secret-token|password=/i);
assert.ok(calls.includes('connect'));

assert.throws(() => manager.get(created.id, 'wrong-token'), (error) => error.status === 404);
assert.throws(() => manager.get(created.id, ''), (error) => error.status === 404);
assert.throws(
  () => manager.create(),
  (error) => error.status === 409,
);

const finished = await manager.finish(created.id, created.sessionToken);
assert.equal(finished.state, 'CLOSED');
assert.equal(finished.liveUrl, null);
assert.ok(calls.includes('close-browser'));
assert.ok(calls.includes('close-desktop'));
const again = await manager.finish(created.id, created.sessionToken);
assert.equal(again.state, 'CLOSED');
assert.equal(manager.activeCount(), 0);

const blocked = createSessionManager({
  config: { ...baseConfig(), loginMode: 'portal', portalUrl: '', username: '', password: '', selectors: {} },
  desktop: fakeDesktop([]),
  runLogin: async () => {
    throw new Error('should not login');
  },
  logger: silent,
});
assert.throws(() => blocked.create(), (error) => error.status === 400);

const httpConfig = {
  ...baseConfig(),
  appApiKey: 'local-key',
  corsOrigins: ['http://127.0.0.1:5173'],
  staticDir: '',
};
const httpManager = createSessionManager({
  config: httpConfig,
  desktop: {
    viewerUrl,
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
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.browserReady, true);
  assert.equal(healthBody.viewer, 'novnc');
  assert.equal(JSON.stringify(healthBody).includes('local-key'), false);
  assert.doesNotMatch(JSON.stringify(healthBody), /browserless|password/i);

  const missingKey = await fetch(`${base}/api/ihx/session`, { method: 'POST' });
  assert.equal(missingKey.status, 401);

  const missingSession = await fetch(`${base}/api/ihx/session/not-a-session`, {
    headers: { 'X-Api-Key': 'local-key' },
  });
  assert.equal(missingSession.status, 404);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

const routeCalls = [];
const routeManager = createSessionManager({
  config: { ...baseConfig(), appApiKey: '', corsOrigins: ['http://127.0.0.1:5173'], staticDir: '' },
  desktop: fakeDesktop(routeCalls),
  runLogin: async ({ onState }) => {
    await onState('LOGGING_IN', 'Opening the public test page.');
    return { outcome: 'ready', message: 'The public test page is open.' };
  },
  logger: silent,
});
const routeServer = createApp(baseConfig(), routeManager, silent).listen(0, '127.0.0.1');
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

  let readyBody = null;
  const started = Date.now();
  while (Date.now() - started < 2000) {
    const response = await fetch(`${base}/api/ihx/session/${createdBody.id}`, {
      headers: { 'X-Session-Token': createdBody.sessionToken },
    });
    readyBody = await response.json();
    if (readyBody.liveUrl) break;
    await delay(15);
  }
  assert.equal(readyBody.liveUrl, viewerUrl);

  const finishedResponse = await fetch(`${base}/api/ihx/session/${createdBody.id}/finish`, {
    method: 'POST',
    headers: { 'X-Session-Token': createdBody.sessionToken },
  });
  assert.equal(finishedResponse.status, 200);
  const finishedBody = await finishedResponse.json();
  assert.equal(finishedBody.state, 'CLOSED');
  assert.equal(finishedBody.liveUrl, null);
  assert.equal(JSON.stringify(finishedBody).includes(createdBody.sessionToken), false);
  assert.ok(routeCalls.includes('close-desktop'));
} finally {
  await routeManager.closeAll();
  await new Promise((resolve) => routeServer.close(resolve));
}

console.log('self-check passed');

function baseConfig() {
  return {
    loginMode: 'test',
    sessionTimeoutMs: 120000,
    maxActiveSessions: 1,
    selectors: { success: '#ready' },
    staticDir: '',
    appApiKey: '',
    corsOrigins: ['http://127.0.0.1:5173'],
  };
}

function fakeDesktop(calls) {
  return {
    viewerUrl,
    async connect() {
      calls.push('connect');
      return {
        browser: {
          on() {},
          async close() {
            calls.push('close-browser');
          },
        },
        context: {},
        page: {
          async waitForSelector() {
            return true;
          },
        },
        async closeDesktop() {
          calls.push('close-desktop');
        },
      };
    },
  };
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
