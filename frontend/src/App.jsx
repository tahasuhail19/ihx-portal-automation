import { useEffect, useRef, useState } from 'react';
import { createSession, finishSession, getHealth, getSession } from './api.js';

const STORAGE_KEY = 'ihxflow.session';

const STATUS_LABELS = {
  STARTING: 'Starting browser',
  LOGGING_IN: 'Signing in',
  AWAITING_VERIFICATION: 'Waiting for verification',
  READY_FOR_DOCTOR: 'Ready for you',
  FAILED: 'Failed',
  CLOSED: 'Closed',
};

export default function App() {
  const [health, setHealth] = useState(null);
  const [healthError, setHealthError] = useState('');
  const [session, setSession] = useState(null);
  const [sessionToken, setSessionToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const frameRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    getHealth()
      .then((next) => {
        if (!cancelled) setHealth(next);
      })
      .catch((reason) => {
        if (!cancelled) setHealthError(reason.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const saved = readStoredAccess();
    if (!saved) return;
    setSessionToken(saved.sessionToken);
    getSession(saved.id, saved.sessionToken)
      .then((next) => {
        if (next.state === 'FAILED' || next.state === 'CLOSED') {
          clearStoredAccess();
          setSession(next);
          return;
        }
        setSession(next);
      })
      .catch(() => {
        clearStoredAccess();
      });
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!session) return;
    console.log('[IHX] state:', session.state);
    console.log('[IHX] portal URL from the case:', session.portalUrl || '(waiting for the case)');
    console.log('[IHX] Chrome opens that portal URL. This page only shows the viewer:', session.liveUrl || '(viewer not ready)');
  }, [session]);

  useEffect(() => {
    if (!session?.id || !sessionToken) return undefined;
    if (session.state === 'FAILED' || session.state === 'CLOSED') return undefined;
    const timer = setInterval(() => {
      getSession(session.id, sessionToken)
        .then((next) => {
          setSession(next);
          if (next.state === 'FAILED' || next.state === 'CLOSED') clearStoredAccess();
        })
        .catch((reason) => setError(reason.message));
    }, 1000);
    return () => clearInterval(timer);
  }, [session?.id, session?.state, sessionToken]);

  async function openSession() {
    setBusy(true);
    setError('');
    try {
      const created = await createSession();
      const token = created.sessionToken;
      writeStoredAccess(created.id, token);
      setSessionToken(token);
      const { sessionToken: _hidden, ...visible } = created;
      setSession(visible);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  async function endSession() {
    if (!session?.id || !sessionToken) return;
    setBusy(true);
    setError('');
    try {
      const closed = await finishSession(session.id, sessionToken);
      setSession(closed);
      clearStoredAccess();
      setSessionToken('');
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  const active = session && session.state !== 'FAILED' && session.state !== 'CLOSED';
  const showBrowser = Boolean(session?.liveUrl);
  const configured = health?.browserReady === true;

  return (
    <main className={showBrowser ? 'shell shell-live' : 'shell'}>
      {showBrowser ? null : <header className="topbar">
        <div>
          <p className="eyebrow">Testing</p>
          <h1>IHX browser session</h1>
        </div>
        <p className="topbar-note">The browser runs in Docker and is shown here.</p>
      </header>}

      {showBrowser ? null : <section className="panel">
        {!health && !healthError ? <p className="muted">Checking the backend…</p> : null}
        {healthError ? <p className="banner bad" role="alert">{healthError}</p> : null}
        {health && !configured ? (
          <p className="banner warn" role="status">
            The backend is missing the browser desktop. Start the app with Docker Compose.
          </p>
        ) : null}
        {health?.loginMode === 'test' ? (
          <p className="banner info" role="status">
            Test mode is on. Open IHX loads a public form so the stream can be checked. The real IHX login is not connected yet.
          </p>
        ) : null}
        {health?.loginMode === 'portal' ? (
          <p className="banner info" role="status">
            {health.caseApi
              ? 'Open IHX loads the waiting IHX case, signs in inside the Docker browser, and enters the email OTP when it arrives. You can still type the 5-digit code in the browser.'
              : 'Open IHX starts the Docker browser, signs in to the provider portal, then waits for the email OTP. Type the 5-digit code in the browser.'}
            {' '}The same browser stays open so you can finish the admission. This session lasts {Math.round(health.sessionTimeoutMs / 60000)} minutes.
          </p>
        ) : null}

        <div className="actions">
          <button type="button" className="primary" onClick={openSession} disabled={busy || active || !configured}>
            {busy && !active ? 'Opening…' : 'Open IHX'}
          </button>
          {active ? (
            <button type="button" className="danger" onClick={endSession} disabled={busy}>
              End Session
            </button>
          ) : null}
        </div>

        {!showBrowser ? (
          <>
            <div className="status-row" aria-live="polite">
              {session ? <span className={`pill ${session.state}`}>{STATUS_LABELS[session.state] || session.state}</span> : <span className="pill">Idle</span>}
              {session?.expiresAt && active ? <span className="muted">{formatRemaining(session.expiresAt, now)}</span> : null}
              {health ? <span className="muted">{Math.round(health.sessionTimeoutMs / 60000)} min session limit</span> : null}
            </div>
            {session?.state === 'STARTING' ? (
              <p className="loading" role="status">
                <span className="spinner" aria-hidden="true" />
                {session.message}
              </p>
            ) : null}
            {session?.portalUrl ? <p className="message">Portal URL: {session.portalUrl}</p> : null}
            {session?.message && session.state !== 'STARTING' ? (
              <p className="message">{session.message}</p>
            ) : null}
            {error || session?.error ? <p className="banner bad" role="alert">{error || session.error}</p> : null}
          </>
        ) : null}
      </section>}

      {showBrowser ? (
        <section className="browser-panel" aria-label="Interactive IHX browser">
          <header className="browser-bar">
            <div>
              <span className={`pill ${session.state}`}>{STATUS_LABELS[session.state] || session.state}</span>
              <p>
                {session.state === 'LOGGING_IN' ? <span className="spinner" aria-hidden="true" /> : null}
                {session.portalUrl ? `${session.portalUrl} · ` : ''}
                {session.message}
                {session?.expiresAt && active ? ` · ${formatRemaining(session.expiresAt, now)}` : ''}
              </p>
            </div>
            <div className="browser-actions">
              <button type="button" onClick={() => frameRef.current?.focus()}>
                Click to type
              </button>
              <button type="button" className="danger" onClick={endSession} disabled={busy}>
                End Session
              </button>
            </div>
          </header>
          <iframe
            ref={frameRef}
            src={session.liveUrl}
            title="Interactive IHX browser"
            sandbox="allow-same-origin allow-scripts"
            allow="clipboard-read; clipboard-write"
            referrerPolicy="no-referrer"
            tabIndex={0}
          />
        </section>
      ) : null}
    </main>
  );
}

function formatRemaining(expiresAt, now) {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return 'Expired';
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds} left`;
}

function readStoredAccess() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '');
    if (!parsed?.id || !parsed?.sessionToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredAccess(id, token) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ id, sessionToken: token }));
}

function clearStoredAccess() {
  sessionStorage.removeItem(STORAGE_KEY);
}
