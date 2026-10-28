import crypto from 'node:crypto';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildViewerUrl } from './browser/desktop.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(rootDir, '.env'), quiet: true });

function requiredText(name, fallback = '') {
  const value = process.env[name];
  return value == null ? fallback : value.trim();
}

function integerEnv(name, fallback, { min, max }) {
  const raw = requiredText(name);
  const value = raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function httpUrl(name, fallback = '') {
  const raw = requiredText(name, fallback);
  if (raw === '') return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an http or https URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must be an http or https URL.`);
  }
  return parsed.toString();
}

function displayEnv() {
  const value = requiredText('DISPLAY', ':99');
  if (!/^:\d+$/.test(value)) {
    throw new Error('DISPLAY must look like :99.');
  }
  return value;
}

export function loadConfig() {
  const loginMode = requiredText('IHX_LOGIN_MODE', 'test');
  if (loginMode !== 'test' && loginMode !== 'portal') {
    throw new Error('IHX_LOGIN_MODE must be "test" or "portal".');
  }

  const credentialSource = requiredText('IHX_CREDENTIALS', 'env');
  if (credentialSource !== 'env' && credentialSource !== 'api') {
    throw new Error('IHX_CREDENTIALS must be "env" or "api".');
  }

  const bindHost = requiredText('HOST', '127.0.0.1');
  const appApiKey = requiredText('APP_API_KEY');
  const localBind = bindHost === '127.0.0.1' || bindHost === 'localhost' || bindHost === '0.0.0.0' || bindHost === '::';
  if (!localBind && appApiKey === '') {
    throw new Error('APP_API_KEY is required when HOST is not a local address.');
  }

  return {
    rootDir,
    display: displayEnv(),
    screenWidth: integerEnv('SCREEN_WIDTH', 1280, { min: 800, max: 1920 }),
    screenHeight: integerEnv('SCREEN_HEIGHT', 800, { min: 600, max: 1200 }),
    vncPort: integerEnv('VNC_PORT', 5900, { min: 1, max: 65535 }),
    novncPort: integerEnv('NOVNC_PORT', 6080, { min: 1, max: 65535 }),
    novncWeb: requiredText('NOVNC_WEB', '/opt/noVNC'),
    viewerUrl: buildViewerUrl(requiredText('VIEWER_URL')),
    sessionTimeoutMs: integerEnv('SESSION_TIMEOUT_MS', 1_800_000, {
      min: 10_000,
      max: 14_400_000,
    }),
    loginMode,
    testPageUrl: httpUrl('TEST_PAGE_URL', 'https://httpbin.org/forms/post'),
    portalUrl: httpUrl('IHX_PORTAL_URL'),
    username: requiredText('IHX_USERNAME'),
    password: requiredText('IHX_PASSWORD'),
    selectors: {
      username: requiredText('IHX_USERNAME_SELECTOR'),
      password: requiredText('IHX_PASSWORD_SELECTOR'),
      submit: requiredText('IHX_SUBMIT_SELECTOR'),
      success: requiredText('IHX_SUCCESS_SELECTOR'),
      verification: requiredText('IHX_VERIFICATION_SELECTOR'),
    },
    appApiKey,
    corsOrigins: requiredText('CORS_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:3001')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    bindHost,
    port: integerEnv('PORT', 3001, { min: 1, max: 65535 }),
    maxActiveSessions: integerEnv('MAX_ACTIVE_SESSIONS', 1, { min: 1, max: 5 }),
    rpaApiBase: httpUrl('RPA_API_BASE', 'https://apistaging.settlemed.in'),
    emailOtpApiBase: httpUrl('EMAIL_OTP_API_BASE', 'https://emailautomate.settlemed.ai'),
    emailOtpFrom: requiredText('EMAIL_OTP_FROM'),
    credentialSource,
    rpaEnabled: credentialSource === 'api' && requiredText('RPA_USERNAME') !== '' && requiredText('RPA_PASSWORD') !== '',
    emailOtpEnabled: requiredText('EMAIL_OTP_EMAIL') !== ''
      && requiredText('EMAIL_OTP_SECRET') !== ''
      && requiredText('EMAIL_OTP_FROM') !== '',
  };
}

export function tokensMatch(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left === '' || right === '') {
    return false;
  }
  const a = crypto.createHash('sha256').update(left).digest();
  const b = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(a, b);
}
