function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function selectHospitalCredential(credentials, payer) {
  const list = Array.isArray(credentials) ? credentials : [];
  const active = list.filter((entry) => String(entry?.status ?? 'ACTIVE').toUpperCase() === 'ACTIVE');
  const pool = active.length ? active : list;
  const portalCredentials = pool.filter((entry) => {
    const platform = String(entry?.tpamaster?.platform ?? '').toLowerCase();
    return platform !== 'email' && entry?.tpamaster?.urlOrReceiverMail;
  });
  if (payer) {
    const named = portalCredentials.find((entry) => entry.tpa === payer || entry.tpamaster?.tpa === payer || entry.tpaName === payer);
    if (named) return named;
  }
  return portalCredentials[0];
}

export function identityOf(credential) {
  return {
    tpaName: credential?.tpaName || credential?.tpa || credential?.tpamaster?.tpa || '',
    portalUrl: credential?.tpamaster?.urlOrReceiverMail || credential?.portalUrl || '',
    username: credential?.userName || credential?.username || '',
    password: credential?.password || '',
  };
}

export function isIhxPortal(identity) {
  const host = hostOf(identity?.portalUrl);
  const name = normalize(identity?.tpaName);
  return host === 'provider.ihx.in' || name.includes('star health') || name.includes('ihx');
}

export function ihxCredentialFromCase(payload) {
  const list = Array.isArray(payload?.hospitalTpaCredentials) ? payload.hospitalTpaCredentials : [];
  const active = list.filter((entry) => String(entry?.status ?? 'ACTIVE').toUpperCase() === 'ACTIVE');
  const pool = (active.length ? active : list)
    .map(identityOf)
    .filter((identity) => identity.username && identity.password && identity.portalUrl && isIhxPortal(identity));
  if (!pool.length) return null;

  const payer = normalize(payload?.caseData?.payer);
  const named = payer
    ? pool.find((identity) => {
      const name = normalize(identity.tpaName);
      return name === payer || name.includes(payer) || payer.includes(name);
    })
    : null;
  const identity = named
    || pool.find((item) => hostOf(item.portalUrl) === 'provider.ihx.in')
    || pool[0];

  return {
    tpaName: identity.tpaName,
    portalUrl: identity.portalUrl,
    username: identity.username,
    password: identity.password,
  };
}

export async function loadIhxCredentials(client, logger = console) {
  const body = await client.fetchRequests();
  const requests = Array.isArray(body?.requests) ? body.requests : [];
  if (!requests.length) {
    logger.info?.('rpa-requests returned no cases.');
    return null;
  }

  for (const request of requests) {
    if (request?.isTpa === false) continue;
    const caseId = String(request?.pmjayRegistrationId ?? '').trim();
    if (!caseId) continue;
    const documentType = String(request?.documentType ?? '').trim() || 'ADMISSIONDOCUMENT';
    const payload = await client.fetchCaseData(caseId, documentType);
    const credential = ihxCredentialFromCase(payload);
    if (!credential) {
      logger.info?.('Skipping a case that is not IHX.');
      continue;
    }
    logger.info?.(`Matched an IHX case for ${credential.tpaName || 'IHX'}.`);
    return credential;
  }

  return null;
}
