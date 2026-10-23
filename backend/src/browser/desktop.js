import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { chromium } from 'playwright-core';
import { redact } from '../redact.js';

const START_TIMEOUT_MS = 20_000;

export function buildViewerUrl(raw) {
  const value = raw || 'http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale&reconnect=1&path=websockify';
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('VIEWER_URL must be an http or https URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('VIEWER_URL must be an http or https URL.');
  }
  if (url.searchParams.has('token') || url.searchParams.has('password')) {
    throw new Error('VIEWER_URL must not contain a token or password.');
  }
  return url.toString();
}

export function createDesktopBrowser(config, logger = console) {
  const children = [];

  return {
    viewerUrl: config.viewerUrl,

    async connect() {
      if (process.platform !== 'linux') {
        throw new Error('The IHX desktop browser runs inside Docker. Start the app with Docker Compose.');
      }
      await stopChildren(children);
      try {
        await startDesktop(config, children, logger);
        const browser = await chromium.launch({
          headless: false,
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--window-position=0,0',
            `--window-size=${config.screenWidth},${config.screenHeight}`,
          ],
          env: { ...process.env, DISPLAY: config.display },
        });
        const context = await browser.newContext({
          viewport: { width: config.screenWidth, height: config.screenHeight },
        });
        const page = await context.newPage();
        return {
          browser,
          context,
          page,
          closeDesktop: () => stopChildren(children),
        };
      } catch (error) {
        await stopChildren(children);
        throw error;
      }
    },

    closeDesktop() {
      return stopChildren(children);
    },
  };
}

async function startDesktop(config, children, logger) {
  const displayNumber = config.display.slice(1);
  const socketPath = `/tmp/.X11-unix/X${displayNumber}`;
  const screen = `${config.screenWidth}x${config.screenHeight}x24`;

  spawnLogged(children, logger, 'Xvfb', [
    config.display,
    '-screen', '0', screen,
    '-ac',
    '+extension', 'GLX',
    '+render',
    '-noreset',
  ]);
  await waitFor(() => fs.existsSync(socketPath), 'The virtual display did not start.');

  spawnLogged(children, logger, 'fluxbox', ['-display', config.display], {
    DISPLAY: config.display,
  });
  await delay(300);

  spawnLogged(children, logger, 'x11vnc', [
    '-display', config.display,
    '-rfbport', String(config.vncPort),
    '-localhost',
    '-nopw',
    '-forever',
    '-shared',
    '-noxdamage',
  ], { DISPLAY: config.display });
  await waitForPort(config.vncPort, 'The VNC server did not start.');

  spawnLogged(children, logger, 'python3', [
    '-m', 'websockify',
    '--web', config.novncWeb,
    `0.0.0.0:${config.novncPort}`,
    `127.0.0.1:${config.vncPort}`,
  ]);
  await waitForPort(config.novncPort, 'The noVNC viewer did not start.');
}

function spawnLogged(children, logger, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });
  child.stdout?.on('data', (chunk) => logDesktop(logger, chunk));
  child.stderr?.on('data', (chunk) => logDesktop(logger, chunk));
  child.on('error', (error) => {
    logger.error?.(`${command} failed to start`, { detail: redact(error.message) });
  });
  children.push(child);
  return child;
}

function logDesktop(logger, chunk) {
  const text = redact(String(chunk || '')).trim();
  if (!text) return;
  logger.info?.('desktop', { detail: text.slice(0, 240) });
}

async function stopChildren(children) {
  const running = children.splice(0);
  for (const child of running) signal(child, 'SIGTERM');
  await delay(400);
  for (const child of running) signal(child, 'SIGKILL');
}

function signal(child, name) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, name);
  } catch {
    try {
      child.kill(name);
    } catch {
      // The process has already exited.
    }
  }
}

async function waitFor(check, message) {
  const started = Date.now();
  while (Date.now() - started < START_TIMEOUT_MS) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error(message);
}

function waitForPort(port, message) {
  return waitFor(() => probePort(port), message);
}

function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
