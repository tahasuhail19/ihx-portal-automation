import crypto from 'node:crypto';
import { tokensMatch } from '../config.js';
import { httpError, redact } from '../redact.js';
import { assertPortalConfigured } from '../ihx/login.js';

const ACTIVE_STATES = new Set([
  'STARTING',
  'LOGGING_IN',
  'AWAITING_VERIFICATION',
  'READY_FOR_DOCTOR',
]);

const FORGET_AFTER_MS = 10 * 60 * 1000;

export function createSessionManager({ config, desktop, runLogin, loadCase = null, readEmailOtp = null, logger = console }) {
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
    if (config.loginMode === 'portal' && !config.rpaEnabled) {
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
      message: 'Starting the browser desktop.',
      error: null,
      liveUrl: null,
      createdAt: now,
      expiresAt: now + config.sessionTimeoutMs,
      terminal: false,
      closePromise: null,
      browser: null,
      page: null,
      closeDesktop: null,
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
    let loginConfig = config;
    try {
      if (config.loginMode === 'portal' && config.rpaEnabled) {
        session.message = 'Checking for an IHX case.';
        const identity = await loadCase?.();
        if (session.terminal) return;
        if (!identity?.username || !identity?.password) {
          await closeSession(session, 'No IHX case is waiting.', 'FAILED');
          return;
        }
        loginConfig = {
          ...config,
          portalUrl: identity.portalUrl || config.portalUrl || 'https://provider.ihx.in/',
          username: identity.username,
          password: identity.password,
          readEmailOtp,
        };
      } else {
        loginConfig = { ...config, readEmailOtp };
      }
      session.portalUrl = loginConfig.portalUrl || null;
      logger.info?.('portal url selected', { sessionId: session.id, portalUrl: session.portalUrl });

      const connection = await desktop.connect();
      if (session.terminal) {
        await connection.browser.close().catch(() => {});
        await connection.closeDesktop().catch(() => {});
        return;
      }
      session.browser = connection.browser;
      session.page = connection.page;
      session.closeDesktop = connection.closeDesktop;
      session.browser.on?.('disconnected', () => {
        if (session.terminal) return;
        session.terminal = true;
        session.state = 'CLOSED';
        session.liveUrl = null;
        session.message = 'The browser disconnected.';
        session.error = null;
        clearTimeout(session.deadlineTimer);
        void session.closeDesktop?.().catch(() => {});
        scheduleForget(session);
        logger.info?.('browser disconnected', { sessionId: session.id, state: session.state });
      });

      session.liveUrl = desktop.viewerUrl;
      session.state = 'LOGGING_IN';
      session.message = 'The browser is open. Signing in.';
      session.error = null;
      logger.info?.('viewer ready', { sessionId: session.id, state: session.state });

      const result = await runLogin({
        page: session.page,
        config: loginConfig,
        onState: async (state, message) => {
          if (session.terminal) return;
          session.state = state;
          session.message = message;
          logger.info?.('session state', { sessionId: session.id, state });
        },
      });

      if (session.terminal) return;

      if (result.outcome === 'verification') {
        setState(session, 'AWAITING_VERIFICATION', result.message);
        if (result.continueAfterOtp) {
          await result.continueAfterOtp(session.page, () => session.terminal);
        } else {
          await waitUntilVerified(session);
        }
        if (session.terminal || session.state !== 'AWAITING_VERIFICATION') return;
        setState(
          session,
          'READY_FOR_DOCTOR',
          'Verification completed. Automation has stopped. Finish the admission yourself in this browser.',
        );
        return;
      }

      setState(session, 'READY_FOR_DOCTOR', result.message);
    } catch (error) {
      if (!session.terminal) {
        await desktop.closeDesktop?.().catch(() => {});
        await closeSession(session, friendlyBrowserError(error, loginConfig), 'FAILED');
      }
    }
  }

  async function waitUntilVerified(session) {
    while (!session.terminal && session.state === 'AWAITING_VERIFICATION') {
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
        await session.browser?.close();
      } catch {
        // The browser may already be closed.
      }
      try {
        await session.closeDesktop?.();
      } catch {
        // The desktop processes may already be gone.
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
      portalUrl: session.portalUrl || null,
      liveUrl: interactive ? session.liveUrl : null,
      expiresAt: new Date(session.expiresAt).toISOString(),
      createdAt: new Date(session.createdAt).toISOString(),
    };
    if (includeToken) view.sessionToken = session.token;
    return view;
  }

  return { create, get, finish, closeAll, activeCount };
}

function setState(session, state, message) {
  if (session.terminal) return;
  session.state = state;
  session.message = message;
  session.error = null;
}

function friendlyBrowserError(error, config = {}) {
  let raw = redact(error?.message || 'The browser session failed.');
  if (config.password) raw = raw.split(config.password).join('[redacted]');
  if (config.username) raw = raw.split(config.username).join('[redacted]');
  if (/xvfb|x11vnc|websockify|novnc|virtual display|docker compose/i.test(raw)) {
    return 'The browser desktop failed to start. Start the app with Docker Compose and try again.';
  }
  return raw;
}
