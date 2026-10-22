import crypto from 'node:crypto';
import { tokensMatch } from '../config.js';
import { httpError, redact } from '../redact.js';
import { assertPortalConfigured, isIhxProvider, isProviderSignedIn } from '../ihx/login.js';

const ACTIVE_STATES = new Set([
  'STARTING',
  'LOGGING_IN',
  'AWAITING_VERIFICATION',
  'READY_FOR_DOCTOR',
]);

const FAILURE_CATEGORIES = new Set([
  'verification',
  'missingInfo',
  'pageBroken',
  'unexpected',
  'other',
]);

const FORGET_AFTER_MS = 10 * 60 * 1000;

export function createSessionManager({ config, browserless, runLogin, logger = console }) {
  const sessions = new Map();

  function activeCount() {
    let count = 0;
    for (const session of sessions.values()) {
      if (!session.terminal && ACTIVE_STATES.has(session.state)) count += 1;
    }
    return count;
  }

  function requireSession(id, sessionToken) {
    const session = sessions.get(id);
    if (!session || !tokensMatch(session.token, sessionToken || '')) {
      throw httpError(404, 'Session not found.');
    }
    return session;
  }

  function create() {
    if (!config.browserlessToken) {
      throw httpError(
        503,
        'Browserless is not configured. Add BROWSERLESS_TOKEN to the .env file in the project root and restart the backend.',
      );
    }
    if (config.loginMode === 'portal') {
      assertPortalConfigured(config);
    }
    if (activeCount() >= config.maxActiveSessions) {
      throw httpError(
        409,
        'An IHX browser session is already active. End it before opening another.',
      );
    }

    const now = Date.now();
    const session = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(32).toString('hex'),
      state: 'STARTING',
      message: 'Starting the remote browser.',
      error: null,
      liveUrl: null,
      liveURLId: null,
      createdAt: now,
      expiresAt: now + config.sessionTimeoutMs,
      terminal: false,
      closePromise: null,
      userDoneHandled: false,
      browser: null,
      context: null,
      page: null,
      cdp: null,
      deadlineTimer: null,
    };
    sessions.set(session.id, session);
    session.deadlineTimer = setTimeout(() => {
      void closeSession(session, 'The browser session reached its time limit.', 'CLOSED');
    }, config.sessionTimeoutMs);

    logger.info?.('session created', { sessionId: session.id, state: session.state });
    void run(session);
    return publicView(session, { includeToken: true });
  }

  function get(id, sessionToken) {
    return publicView(requireSession(id, sessionToken));
  }

  function finish(id, sessionToken) {
    const session = requireSession(id, sessionToken);
    if (session.terminal) return Promise.resolve(publicView(session));
    return closeSession(session, 'The doctor ended the session.', 'CLOSED');
  }

  async function closeAll() {
    const closing = [];
    for (const session of sessions.values()) {
      if (!session.terminal) {
        closing.push(closeSession(session, 'The server is shutting down.', 'CLOSED'));
      }
    }
    await Promise.all(closing);
  }

  async function run(session) {
    try {
      const connection = await browserless.connect();
      if (session.terminal) {
        await connection.browser.close().catch(() => {});
        return;
      }
      session.browser = connection.browser;
      session.context = connection.context;
      session.page = connection.page;
      session.browser.on?.('disconnected', () => {
        if (session.terminal) return;
        session.terminal = true;
        session.state = 'CLOSED';
        session.liveUrl = null;
        session.message = 'The remote browser disconnected.';
        session.error = null;
        clearTimeout(session.deadlineTimer);
        scheduleForget(session);
        logger.info?.('browser disconnected', { sessionId: session.id, state: session.state });
      });

      await publishLive(
        session,
        'LOGGING_IN',
        'The remote browser is open. Signing in to IHX.',
        signingInCard(),
      );

      const result = await runLogin({
        page: session.page,
        config,
        onState: async (state, message) => {
          if (session.terminal) return;
          session.state = state;
          session.message = message;
          logger.info?.('session state', { sessionId: session.id, state });
        },
      });

      if (session.terminal) {
        await session.browser?.close().catch(() => {});
        return;
      }

      if (result.outcome === 'verification') {
        await reveal(session, 'AWAITING_VERIFICATION', result.message, verificationCard());
        if (result.continueAfterOtp) {
          await result.continueAfterOtp(session.page, () => session.terminal);
        } else {
          await waitUntilVerified(session);
        }
        if (session.terminal || session.state !== 'AWAITING_VERIFICATION') return;
        await markVerified(session);
        return;
      }

      await reveal(session, 'READY_FOR_DOCTOR', result.message, readyCard(config));
    } catch (error) {
      if (session.terminal) return;
      await closeSession(session, friendlyBrowserError(error, config), 'FAILED');
    }
  }

  async function reveal(session, state, message, instructions) {
    if (!session.liveUrl) {
      await publishLive(session, state, message, instructions);
      return;
    }
    if (session.terminal) return;
    session.state = state;
    session.message = message;
    session.error = null;
    if (instructions && session.cdp && session.liveURLId) {
      try {
        await browserless.replaceInstructions(session.cdp, session.liveURLId, instructions, 'Finish session');
      } catch (error) {
        logger.error?.('could not update live instructions', {
          sessionId: session.id,
          detail: redact(error?.message || ''),
        });
      }
    }
    logger.info?.('session state', { sessionId: session.id, state });
  }

  async function publishLive(session, state, message, instructions) {
    const minted = await mint(session, instructions);
    if (session.terminal) return;
    session.liveUrl = minted.liveURL;
    session.liveURLId = minted.liveURLId;
    session.state = state;
    session.message = message;
    session.error = null;
    logger.info?.('live url minted', { sessionId: session.id, state });
  }

  async function mint(session, instructions) {
    const timeout = remainingMs(session);
    if (!session.cdp) {
      session.cdp = await browserless.openCdp(session.context, session.page);
      attachLiveWatcher(session);
    }
    return browserless.mintLiveUrl(session.cdp, {
      timeout,
      interactable: true,
      resizable: true,
      showBrowserInterface: false,
      quality: 20,
      mode: 'follow',
      instructions,
      doneLabel: 'Finish session',
    });
  }

  function attachLiveWatcher(session) {
    session.cdp.on?.('Browserless.liveComplete', (event) => {
      if (session.terminal) return;
      if (event?.liveURLId && session.liveURLId && event.liveURLId !== session.liveURLId) return;
      if (event?.reason === 'viewerDisconnected' || event?.reason === 'closed') return;
      if (event?.reason === 'userDone') {
        void handleUserDone(session);
        return;
      }
      if (event?.reason === 'userFailed') {
        const category = FAILURE_CATEGORIES.has(event?.feedback?.category)
          ? event.feedback.category
          : '';
        void closeSession(
          session,
          category ? `The viewer could not continue (${category}).` : 'The viewer could not continue.',
          'FAILED',
        );
        return;
      }
      if (event?.reason === 'timeout') {
        void closeSession(session, 'The interactive browser link expired.', 'CLOSED');
      }
    });
  }

  async function handleUserDone(session) {
    if (session.terminal || session.userDoneHandled) return;
    session.userDoneHandled = true;
    if (session.state !== 'AWAITING_VERIFICATION') {
      await closeSession(session, 'The doctor finished the session.', 'CLOSED');
      return;
    }

    const verified = isIhxProvider(config)
      ? await isProviderSignedIn(session.page).catch(() => false)
      : await session.page
        .waitForSelector(config.selectors.success, { timeout: 2000 })
        .then(() => true)
        .catch(() => false);
    if (!verified) {
      if (isIhxProvider(config)) {
        session.userDoneHandled = false;
        session.liveUrl = null;
        session.liveURLId = null;
        try {
          await publishLive(
            session,
            'AWAITING_VERIFICATION',
            'Enter the 5-digit OTP sent to the registered email. Sign-in has not finished yet.',
            verificationCard(),
          );
        } catch (error) {
          if (!session.terminal) await closeSession(session, friendlyBrowserError(error, config), 'FAILED');
        }
        return;
      }
      await closeSession(
        session,
        'Finish was chosen before the portal reached the configured success page.',
        'FAILED',
      );
      return;
    }

    session.userDoneHandled = false;
    session.liveUrl = null;
    session.liveURLId = null;
    try {
      await publishLive(
        session,
        'READY_FOR_DOCTOR',
        'Verification completed. Automation has stopped. Finish the admission yourself in this browser.',
        readyCard(config),
      );
    } catch (error) {
      if (!session.terminal) {
        await closeSession(session, friendlyBrowserError(error, config), 'FAILED');
      }
    }
  }

  async function waitUntilVerified(session) {
    while (!session.terminal && !session.userDoneHandled && session.state === 'AWAITING_VERIFICATION') {
      const left = session.expiresAt - Date.now();
      if (left < 2000) {
        throw new Error('Verification was not completed before the session expired.');
      }
      try {
        await session.page.waitForSelector(config.selectors.success, {
          timeout: Math.min(left - 1000, 5000),
        });
        return;
      } catch (error) {
        if (session.terminal) return;
        if (!/timeout/i.test(String(error?.message || ''))) throw error;
      }
    }
  }

  async function markVerified(session) {
    try {
      await browserless.replaceInstructions(
        session.cdp,
        session.liveURLId,
        readyCard(config),
        'Finish session',
      );
    } catch (error) {
      logger.error?.('could not update live instructions', {
        sessionId: session.id,
        detail: redact(error?.message || ''),
      });
    }
    if (session.terminal) return;
    session.state = 'READY_FOR_DOCTOR';
    session.message = 'Verification completed. Automation has stopped. Finish the admission yourself in this browser.';
    session.error = null;
    logger.info?.('session state', { sessionId: session.id, state: session.state });
  }

  function closeSession(session, message, state) {
    if (session.closePromise) return session.closePromise;
    session.closePromise = (async () => {
      session.terminal = true;
      session.state = state;
      session.message = message;
      session.liveUrl = null;
      session.error = state === 'FAILED' ? message : null;
      clearTimeout(session.deadlineTimer);
      try {
        await browserless.closeLiveUrl(session.cdp, session.liveURLId);
      } catch {
        // The live URL may already be closed.
      }
      try {
        await session.browser?.close();
      } catch {
        // The browser may already be disconnected.
      }
      scheduleForget(session);
      logger.info?.('session ended', { sessionId: session.id, state });
      return publicView(session);
    })();
    return session.closePromise;
  }

  function scheduleForget(session) {
    const timer = setTimeout(() => sessions.delete(session.id), FORGET_AFTER_MS);
    timer.unref?.();
  }

  function publicView(session, { includeToken = false } = {}) {
    const interactive = session.state === 'LOGGING_IN'
      || session.state === 'READY_FOR_DOCTOR'
      || session.state === 'AWAITING_VERIFICATION';
    const view = {
      id: session.id,
      state: session.state,
      message: session.message,
      error: session.error,
      loginMode: config.loginMode,
      liveUrl: interactive ? session.liveUrl : null,
      expiresAt: new Date(session.expiresAt).toISOString(),
      createdAt: new Date(session.createdAt).toISOString(),
    };
    if (includeToken) view.sessionToken = session.token;
    return view;
  }

  return { create, get, finish, closeAll, activeCount };
}

function remainingMs(session) {
  const left = Math.floor(session.expiresAt - Date.now() - 1000);
  if (left < 1000) {
    throw new Error('Not enough session time remains to open the interactive browser.');
  }
  return left;
}

function readyCard(config) {
  if (config.loginMode === 'portal') {
    return {
      layout: 'panel',
      title: 'IHX is signed in',
      summary: 'Login automation has stopped. Complete the admission yourself in this browser.',
      steps: [
        'Continue the admission in this browser.',
        'Choose Finish session when you are done.',
      ],
      currentStep: 1,
    };
  }
  return {
    layout: 'panel',
    title: 'Test browser',
    summary: 'A public test page is open. The IHX portal is not connected, and nothing after this page is automated.',
    steps: [
      'Click and type on the page to confirm the stream.',
      'Choose Finish session when you are done.',
    ],
    currentStep: 1,
  };
}

function signingInCard() {
  return {
    layout: 'panel',
    title: 'Signing in',
    summary: 'Watch this browser. The cookie dialog closes, then the username and password are typed, then the OTP boxes appear.',
    steps: [
      'Watch the IHX page in this browser.',
      'Type the 5-digit email OTP when the boxes appear.',
    ],
    currentStep: 1,
  };
}

function verificationCard() {
  return {
    layout: 'panel',
    title: 'Enter the email OTP',
    summary: 'Type the 5-digit code sent to the registered email. Sign-in continues after the code is entered. This app does not read the email.',
    steps: [
      'Type the 5-digit OTP in the boxes.',
      'Wait until IHX finishes signing in.',
    ],
    currentStep: 1,
  };
}

function friendlyBrowserError(error, config = {}) {
  let raw = redact(error?.message || 'The browser session failed.');
  if (config.password) raw = raw.split(config.password).join('[redacted]');
  if (config.username) raw = raw.split(config.username).join('[redacted]');
  if (/maximum allowed|exceeds the maximum|maximum session/i.test(raw)) {
    return `${raw} Lower SESSION_TIMEOUT_MS to the plan maximum, or upgrade the Browserless plan.`;
  }
  if (/401|403|invalid api key|no valid credentials/i.test(raw)) {
    return 'Browserless rejected the API token. Check BROWSERLESS_TOKEN in the project root .env file.';
  }
  return raw;
}
