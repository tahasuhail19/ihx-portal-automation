import { chromium } from 'playwright-core';

const CONNECT_TIMEOUT_MS = 30_000;

export function buildConnectionUrl({ token, host, timeoutMs, stealth, proxy, proxyCountry }) {
  if (!token) {
    throw new Error('BROWSERLESS_TOKEN is empty.');
  }
  const url = new URL(`wss://${host}${stealth ? '/chromium/stealth' : '/chromium'}`);
  url.searchParams.set('token', token);
  url.searchParams.set('timeout', String(timeoutMs));
  if (proxy === 'residential' || proxy === 'datacenter') {
    url.searchParams.set('proxy', proxy);
    url.searchParams.set('proxySticky', 'true');
  }
  if (proxyCountry) url.searchParams.set('proxyCountry', proxyCountry);
  return url.toString();
}

export function createBrowserlessClient(config) {
  return {
    buildConnectionUrl() {
      return buildConnectionUrl({
        token: config.browserlessToken,
        host: config.browserlessHost,
        timeoutMs: config.sessionTimeoutMs,
        stealth: config.stealth,
        proxy: config.proxy,
        proxyCountry: config.proxyCountry,
      });
    },

    async connect() {
      const wsEndpoint = this.buildConnectionUrl();
      const browser = await connectWithTimeout(wsEndpoint);
      const context = browser.contexts()[0];
      if (!context) {
        await browser.close().catch(() => {});
        throw new Error('Browserless connected without a browser context.');
      }
      const page = context.pages()[0] ?? (await context.newPage());
      return { browser, context, page };
    },

    async openCdp(context, page) {
      return context.newCDPSession(page);
    },

    async mintLiveUrl(cdp, options) {
      const result = await cdp.send('Browserless.liveURL', options);
      if (result?.error) {
        throw new Error(result.error);
      }
      if (!result?.liveURL || !result?.liveURLId) {
        throw new Error('Browserless did not return a live URL.');
      }
      if (String(result.liveURL).includes('token=')) {
        throw new Error('Refusing to share a live URL that contains an API token.');
      }
      return result;
    },

    async replaceInstructions(cdp, liveURLId, instructions, doneLabel) {
      const result = await cdp.send('Browserless.setLiveURLInstructions', {
        liveURLId,
        instructions,
        doneLabel,
      });
      if (result?.error) {
        throw new Error(result.error);
      }
    },

    async closeLiveUrl(cdp, liveURLId) {
      if (!cdp || !liveURLId) return;
      await cdp.send('Browserless.closeLiveURL', { liveURLId });
    },
  };
}

async function connectWithTimeout(wsEndpoint) {
  let timer;
  let settled = false;
  const browserPromise = chromium.connectOverCDP(wsEndpoint);
  try {
    const browser = await Promise.race([
      browserPromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Timed out connecting to Browserless. Check the API token, host, and network.'));
        }, CONNECT_TIMEOUT_MS);
      }),
    ]);
    settled = true;
    return browser;
  } catch (error) {
    settled = true;
    browserPromise.then((browser) => browser.close().catch(() => {})).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    if (!settled) {
      browserPromise.then((browser) => browser.close().catch(() => {})).catch(() => {});
    }
  }
}
