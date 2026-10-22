import crypto from 'node:crypto';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(rootDir, '.env'), quiet: true });

const REGIONS = new Set([
  'production-sfo.browserless.io',
  'production-lon.browserless.io',
  'production-ams.browserless.io',
]);

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

function booleanEnv(name, fallback) {
  const raw = requiredText(name);
  if (raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false.`);
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

function proxyEnv() {
  const value = requiredText('BROWSERLESS_PROXY').toLowerCase();
  if (value === '' || value === 'residential' || value === 'datacenter') return value;
  throw new Error('BROWSERLESS_PROXY must be residential, datacenter, or empty.');
}

function countryEnv() {
  const value = requiredText('BROWSERLESS_PROXY_COUNTRY').toLowerCase();
  if (value === '') return '';
  if (!/^[a-z]{2}$/.test(value)) {
    throw new Error('BROWSERLESS_PROXY_COUNTRY must be a two-letter country code.');
  }
  return value;
}

function browserlessHost() {
  const host = requiredText('BROWSERLESS_HOST', 'production-sfo.browserless.io').toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes('..')) {
    throw new Error('BROWSERLESS_HOST must be a hostname, without a protocol or path.');
  }
  return host;
}

export function loadConfig() {
  const loginMode = requiredText('IHX_LOGIN_MODE', 'test');
  if (loginMode !== 'test' && loginMode !== 'portal') {
    throw new Error('IHX_LOGIN_MODE must be "test" or "portal".');
  }

  const host = browserlessHost();
  const bindHost = requiredText('HOST', '127.0.0.1');
  const appApiKey = requiredText('APP_API_KEY');
  const localhost = bindHost === '127.0.0.1' || bindHost === 'localhost';
  if (!localhost && appApiKey === '') {
    throw new Error('APP_API_KEY is required when HOST is not localhost.');
  }

  return {
    rootDir,
    browserlessToken: requiredText('BROWSERLESS_TOKEN'),
    browserlessHost: host,
    browserlessOrigin: `https://${host}`,
    knownCloudRegion: REGIONS.has(host),
    stealth: booleanEnv('BROWSERLESS_STEALTH', false),
    proxy: proxyEnv(),
    proxyCountry: countryEnv(),
    sessionTimeoutMs: integerEnv('SESSION_TIMEOUT_MS', 120_000, {
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
    corsOrigins: requiredText('CORS_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    bindHost,
    port: integerEnv('PORT', 3001, { min: 1, max: 65535 }),
    maxActiveSessions: integerEnv('MAX_ACTIVE_SESSIONS', 1, { min: 1, max: 5 }),
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
