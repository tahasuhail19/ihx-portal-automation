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
  return { id: 'other', label: 'portal', loginUrl: portalUrl, otpFrom: '' };
}

export async function runCasePortalLogin({ page, config, onState }) {
  const openUrl = config.portalUrl;
  await onState('LOGGING_IN', `Opening ${openUrl}`);
  await page.goto(openUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  return {
    outcome: 'ready',
    message: `Opened ${openUrl}. Sign-in automation runs only for provider.ihx.in. Continue in this browser.`,
  };
}
