export function portalProfile(portalUrl) {
  let host = '';
  try {
    host = new URL(portalUrl).hostname;
  } catch {
    host = '';
  }
  if (host === 'provider.ihx.in') {
    return { id: 'ihx', label: 'IHX', loginUrl: portalUrl, otpFrom: 'support@ihx.in' };
  }
  if (host === 'epreauth.fhpl.net') {
    return {
      id: 'fhpl',
      label: 'Family Health Plan',
      loginUrl: 'https://epreauth.fhpl.net/Login.aspx',
      otpFrom: '',
    };
  }
  if (host === 'ilhc.icicilombard.com') {
    return {
      id: 'icici',
      label: 'ICICI Lombard',
      loginUrl: 'https://ilhc.icicilombard.com/Home/Login',
      otpFrom: 'WEBLOGIN@icicilombard.com',
    };
  }
  if (host === 'first.godigit.com' || host.endsWith('.godigit.com')) {
    return {
      id: 'digit',
      label: 'Go Digit',
      loginUrl: 'https://first.godigit.com/hospitallogin/#/home',
      otpFrom: 'noreply@godigit.com',
    };
  }
  if (host === 'provider.volohealthtpa.com') {
    return {
      id: 'volo',
      label: 'Volo',
      loginUrl: 'https://provider.volohealthtpa.com/login',
      otpFrom: '',
    };
  }
  return { id: 'other', label: 'portal', loginUrl: portalUrl, otpFrom: '' };
}

export async function runCasePortalLogin({ page, config, onState }) {
  const profile = portalProfile(config.portalUrl);
  const openUrl = profile.loginUrl || config.portalUrl;
  await onState('LOGGING_IN', `Opening ${openUrl}`);
  if (profile.id === 'icici') {
    await page.route('**/*disable-devtool*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: '',
    })).catch(() => {});
    page.on('dialog', (dialog) => {
      dialog.accept().catch(() => {});
    });
  }
  await page.goto(openUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });

  if (profile.id === 'other') {
    return {
      outcome: 'ready',
      message: `Opened ${config.portalUrl}. Continue in this browser.`,
    };
  }

  try {
    if (!(await loginFormVisible(page, profile, 15_000))) {
      return {
        outcome: 'ready',
        message: `Opened ${config.portalUrl}. The login form was not found. Continue in this browser.`,
      };
    }

    let previousOtp = '';
    if (profile.otpFrom && config.readEmailOtp) {
      previousOtp = await config.readEmailOtp({ attempts: 1, from: profile.otpFrom }).catch(() => '');
    }

    await onState('LOGGING_IN', `Signing in to ${profile.label}.`);
    if (profile.id === 'fhpl') await signInFhpl(page, config);
    if (profile.id === 'icici') await signInIcici(page, config);
    if (profile.id === 'digit') await signInDigit(page, config);
    if (profile.id === 'volo') await signInVolo(page, config);

    if (profile.otpFrom) {
      await enterEmailOtp(page, config, profile, previousOtp, onState);
    }

    if (page.url() !== config.portalUrl) {
      await page.goto(config.portalUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    }
    const otpNote = profile.otpFrom ? ' The email OTP was entered.' : '';
    return {
      outcome: 'ready',
      message: `Signed in to ${profile.label}.${otpNote} Continue in this browser.`,
    };
  } catch (error) {
    return {
      outcome: 'ready',
      message: safeLoginMessage(error, config, profile),
    };
  }
}

function safeLoginMessage(error, config, profile) {
  let raw = String(error?.message || 'The portal is open. Continue in this browser.');
  if (config.password) raw = raw.split(config.password).join('');
  if (config.username) raw = raw.split(config.username).join('');
  raw = raw.trim();
  if (!raw || /timeout|locator|waiting for/i.test(raw)) {
    return `${profile.label} is open. Continue the login in this browser.`;
  }
  return raw;
}

async function loginFormVisible(page, profile, timeout) {
  const locator = loginLocator(page, profile);
  if (!locator) return false;
  return locator.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);
}

function loginLocator(page, profile) {
  if (profile.id === 'fhpl') return page.locator('#txtUserName');
  if (profile.id === 'icici') return page.getByRole('textbox', { name: 'User Name:', exact: true });
  if (profile.id === 'digit') return page.getByRole('textbox', { name: 'Phone Number' });
  if (profile.id === 'volo') return page.getByRole('textbox', { name: 'User Name', exact: true });
  return null;
}

async function signInFhpl(page, config) {
  const user = page.locator('#txtUserName');
  const pass = page.locator('#txtPassword');
  await user.waitFor({ state: 'visible', timeout: 15_000 });
  await user.fill(config.username);
  await pass.fill(config.password);
  const kept = await page.evaluate((username) => {
    const userBox = document.querySelector('#txtUserName');
    const passBox = document.querySelector('#txtPassword');
    return userBox?.value === username && passBox?.value.length > 0;
  }, config.username);
  if (!kept) throw new Error('Family Health Plan did not keep the username and password.');
  await page.locator('#btnLogIn').click();
  await page.waitForFunction(() => !/Login\.aspx/i.test(location.pathname), { timeout: 20_000 });
}

async function signInIcici(page, config) {
  await page.getByRole('textbox', { name: 'User Name:', exact: true }).fill(config.username);
  await page.getByRole('textbox', { name: 'Password:', exact: true }).fill(config.password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  const rejected = await page.getByText('Invalid User Name or Password').waitFor({
    state: 'visible',
    timeout: 4_000,
  }).then(() => true).catch(() => false);
  if (rejected) throw new Error('ICICI Lombard rejected the username or password.');
}

async function signInDigit(page, config) {
  await page.getByRole('textbox', { name: 'Phone Number' }).fill(config.username);
  await page.getByRole('button', { name: 'Send OTP', exact: true }).click();
}

async function signInVolo(page, config) {
  const ok = page.getByRole('button', { name: 'OK', exact: true });
  if (await ok.isVisible().catch(() => false)) await ok.click().catch(() => {});
  await page.getByRole('textbox', { name: 'User Name', exact: true }).fill(config.username);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(config.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function enterEmailOtp(page, config, profile, previousOtp, onState) {
  const target = await otpTarget(page, profile);
  if (!config.readEmailOtp) {
    throw new Error(`${profile.label} is waiting for an OTP. Type it in this browser.`);
  }
  await onState('LOGGING_IN', `Reading the ${profile.label} email OTP.`);
  const code = await config.readEmailOtp({
    untilDifferentFrom: previousOtp,
    from: profile.otpFrom,
    attempts: 12,
  });
  if (!/^\d{4,8}$/.test(code)) {
    throw new Error(`${profile.label} is waiting for an OTP. Type it in this browser.`);
  }
  await target.box.click();
  await target.box.fill(code);
  const entered = (await target.box.inputValue().catch(() => '')).trim();
  if (entered !== code) {
    await target.box.fill('');
    await target.box.pressSequentially(code, { delay: 40 });
  }
  await target.verify.click();
  await page.waitForTimeout(2500);
}

async function otpTarget(page, profile) {
  if (profile.id === 'digit') {
    const box = page.getByRole('textbox', { name: 'Enter OTP' });
    await box.waitFor({ state: 'visible', timeout: 20_000 });
    return { box, verify: page.getByRole('button', { name: 'Login', exact: true }) };
  }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const box = frame.locator('#txtOTP');
      if (await box.isVisible().catch(() => false)) {
        return { box, verify: frame.locator('#btnVerify') };
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`${profile.label} is waiting for an OTP. Type it in this browser.`);
}
