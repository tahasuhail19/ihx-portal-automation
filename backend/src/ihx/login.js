import { httpError } from '../redact.js';

const LOGIN_WAIT_MS = 30_000;
const OTP_LENGTH = 5;

const PROVIDER = {
  username: '#login-form_username',
  password: '#login-form_password',
  submit: 'button.login-btn',
  otp: '.otp_login',
  verify: 'button.btn-form-submit',
  loginBox: '.login-box',
  cookie: 'button.cookie-accept-button',
  passwordExpired: '.password-expired-message',
};

export function assertPortalConfigured(config) {
  const missing = [];
  if (!config.portalUrl) missing.push('IHX_PORTAL_URL');
  if (!config.username) missing.push('IHX_USERNAME');
  if (!config.password) missing.push('IHX_PASSWORD');
  if (!isIhxProvider(config)) {
    if (!config.selectors.username) missing.push('IHX_USERNAME_SELECTOR');
    if (!config.selectors.password) missing.push('IHX_PASSWORD_SELECTOR');
    if (!config.selectors.submit) missing.push('IHX_SUBMIT_SELECTOR');
    if (!config.selectors.success) missing.push('IHX_SUCCESS_SELECTOR');
  }
  if (missing.length > 0) {
    throw httpError(
      400,
      `Portal login is not configured. Add ${missing.join(', ')}.`,
    );
  }
}

export function isIhxProvider(config) {
  try {
    return new URL(config.portalUrl).hostname === 'provider.ihx.in';
  } catch {
    return false;
  }
}

export async function isProviderSignedIn(page) {
  return page.evaluate(() => {
    const login = document.querySelector('.login-box');
    const otp = document.querySelector('.otp_login');
    const user = document.querySelector('#login-form_username');
    return !login && !otp && !user && location.hostname === 'provider.ihx.in';
  }).catch(() => false);
}

export async function runIhxLogin({ page, config, onState }) {
  if (config.loginMode === 'test') {
    await onState('LOGGING_IN', 'Opening the public test page. Portal login is not configured.');
    await page.goto(config.testPageUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    return {
      outcome: 'ready',
      message: 'The public test page is open. Automation has stopped. Click and type in the browser, then end the session.',
    };
  }

  assertPortalConfigured(config);
  if (isIhxProvider(config)) return runProviderLogin({ page, config, onState });

  await onState('LOGGING_IN', 'Opening the configured portal and submitting the login form.');
  await page.goto(config.portalUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.locator(config.selectors.username).fill(config.username, { timeout: LOGIN_WAIT_MS });
  await page.locator(config.selectors.password).fill(config.password, { timeout: LOGIN_WAIT_MS });
  await page.locator(config.selectors.submit).click({ timeout: LOGIN_WAIT_MS });

  const outcome = await waitForLoginResult(page, config.selectors);
  if (outcome === 'verification') {
    return {
      outcome: 'verification',
      message: 'The portal is waiting for verification. Enter the code in the browser. This app does not read or bypass it.',
    };
  }
  if (outcome === 'success') {
    return {
      outcome: 'ready',
      message: 'Login succeeded. Automation has stopped. Finish the admission yourself in this browser.',
    };
  }
  throw new Error('Login did not reach the configured success or verification state. Check the selectors. No further workflow was attempted.');
}

async function runProviderLogin({ page, config, onState }) {
  await page.setViewportSize({ width: 1024, height: 640 }).catch(() => {});

  await onState('LOGGING_IN', 'Opening the IHX portal.');
  await page.goto(config.portalUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  await page.locator(PROVIDER.username).waitFor({ state: 'visible', timeout: 20_000 });
  await dismissCookieConsent(page);

  await onState('LOGGING_IN', 'Signing in. The OTP boxes will appear in this browser.');
  await writeLoginField(page, PROVIDER.username, config.username);
  await page.waitForTimeout(150);
  await writeLoginField(page, PROVIDER.password, config.password);
  await page.waitForTimeout(150);
  const fieldsKept = await page.evaluate(({ username, password, userSelector, passSelector }) => {
    const user = document.querySelector(userSelector);
    const pass = document.querySelector(passSelector);
    return user?.value === username && pass?.value === password;
  }, {
    username: config.username,
    password: config.password,
    userSelector: PROVIDER.username,
    passSelector: PROVIDER.password,
  });
  if (!fieldsKept) {
    throw new Error('The IHX login form did not keep the username and password. Sign-in was not submitted.');
  }

  await page.locator(PROVIDER.submit).click({ timeout: 8_000 });
  let next = await waitForProviderStep(page);
  if (next.step === 'rejected' && /internet connection/i.test(next.notice || '')) {
    await page.locator(PROVIDER.submit).click({ timeout: 8_000 });
    next = await waitForProviderStep(page);
  }
  if (next.step === 'ready') {
    return {
      outcome: 'ready',
      message: 'Login succeeded. Automation has stopped. Finish the admission yourself in this browser.',
    };
  }
  if (next.step === 'expired') {
    return {
      outcome: 'ready',
      message: 'IHX says the password has expired. Automation has stopped. Continue in the browser.',
    };
  }
  if (next.step === 'otp') {
    return {
      outcome: 'verification',
      message: 'Enter the 5-digit OTP sent to the registered email. Sign-in continues automatically after you type it.',
      continueAfterOtp: continueProviderOtp,
    };
  }

  const safeNotice = (next.notice || '')
    .replaceAll(config.password, '')
    .replaceAll(config.username, '')
    .trim();
  throw new Error(safeNotice
    ? `IHX did not open the OTP step. ${safeNotice}`
    : 'IHX stayed on the login page and did not open the OTP step.');
}

async function dismissCookieConsent(page) {
  const accept = page.getByRole('button', { name: 'Accept Necessary Cookies Only' });
  const visible = await accept.waitFor({ state: 'visible', timeout: 4_000 }).then(() => true).catch(() => false);
  if (!visible) return;
  await accept.click({ timeout: 3_000 });
  await page.locator('.ant-modal-wrap').waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => {});
}

async function writeLoginField(page, selector, value) {
  await page.locator(selector).evaluate((el, next) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    if (el._valueTracker) el._valueTracker.setValue('');
    setter.call(el, next);
    const propsKey = Object.keys(el).find((key) => key.startsWith('__reactProps$') || key.startsWith('__reactEventHandlers$'));
    const props = propsKey ? el[propsKey] : null;
    if (props && typeof props.onChange === 'function') {
      props.onChange({ target: el, currentTarget: el });
      return;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

export async function continueProviderOtp(page, isCancelled) {
  let submitted = '';
  while (!isCancelled()) {
    if (await isProviderSignedIn(page)) return;
    const otp = await page.waitForFunction((previous) => {
      const inputs = [...document.querySelectorAll('.otp_login input, .twoFactorOtpContainer input')];
      const values = inputs.map((input) => input.value || '');
      const combined = values.find((value) => value.length >= 5) || values.join('');
      return combined.length === 5 && combined !== previous ? combined : null;
    }, submitted, { timeout: 4_000, polling: 300 }).then((handle) => handle.jsonValue()).catch(() => '');
    if (!otp || isCancelled()) continue;
    submitted = otp;
    const verify = page.locator(PROVIDER.verify);
    if (await verify.isVisible().catch(() => false)) await verify.click();
    await page.waitForFunction(() => {
      const login = document.querySelector('.login-box');
      const otpBox = document.querySelector('.otp_login');
      const user = document.querySelector('#login-form_username');
      const loading = document.querySelector('button.btn-form-submit.ant-btn-loading');
      return (!login && !otpBox && !user && location.hostname === 'provider.ihx.in') || !loading;
    }, { timeout: 12_000 }).catch(() => {});
    if (await isProviderSignedIn(page)) return;
  }
}

async function waitForProviderStep(page) {
  const handle = await page.waitForFunction(() => {
    const notice = [...document.querySelectorAll('.ant-message-notice, .ant-notification-notice, .ant-form-item-explain-error')]
      .map((node) => (node.innerText || '').trim())
      .filter(Boolean)
      .join(' ');
    if (document.querySelector('.otp_login')) return { step: 'otp', notice };
    if (document.querySelector('.password-expired-message')) return { step: 'expired', notice };
    const login = document.querySelector('.login-box');
    const user = document.querySelector('#login-form_username');
    if (!login && !user && location.hostname === 'provider.ihx.in') return { step: 'ready', notice };
    const loading = document.querySelector('button.login-btn.ant-btn-loading');
    if (notice && !loading) return { step: 'rejected', notice };
    return null;
  }, { timeout: 20_000, polling: 250 }).catch(() => null);
  if (!handle) return { step: 'timeout', notice: '' };
  return handle.jsonValue();
}

function waitForLoginResult(page, selectors) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish('timeout'), LOGIN_WAIT_MS + 250);
    timer.unref?.();

    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }

    page
      .waitForSelector(selectors.success, { timeout: LOGIN_WAIT_MS })
      .then(() => finish('success'))
      .catch(() => {});

    if (selectors.verification) {
      page
        .waitForSelector(selectors.verification, { timeout: LOGIN_WAIT_MS })
        .then(() => finish('verification'))
        .catch(() => {});
    }
  });
}
