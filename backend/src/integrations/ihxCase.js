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
    portalUrl: credential?.tpamaster?.urlOrReceiverMail || '',
    username: credential?.userName || credential?.username || '',
    password: credential?.password || '',
  };
}

export function isIhxPortal(identity) {
  const host = hostOf(identity?.portalUrl);
  const name = normalize(identity?.tpaName);
  return host === 'provider.ihx.in' || name.includes('star health') || name.includes('ihx');
}

function credentialFromPool(payload, pool) {
  if (!pool.length) return null;
  const payer = normalize(payload?.caseData?.payer);
  const named = payer
    ? pool.find((identity) => {
      const name = normalize(identity.tpaName);
      return name === payer || name.includes(payer) || payer.includes(name);
    })
    : null;
  const identity = named || pool[0];
  return {
    tpaName: identity.tpaName,
    portalUrl: identity.portalUrl,
    username: identity.username,
    password: identity.password,
  };
}

function portalIdentities(payload) {
  const list = Array.isArray(payload?.hospitalTpaCredentials) ? payload.hospitalTpaCredentials : [];
  const active = list.filter((entry) => String(entry?.status ?? 'ACTIVE').toUpperCase() === 'ACTIVE');
  return (active.length ? active : list)
    .map(identityOf)
    .filter((identity) => identity.username && identity.password && identity.portalUrl);
}

export function portalCredentialFromCase(payload) {
  return credentialFromPool(payload, portalIdentities(payload));
}

export function ihxCredentialFromCase(payload) {
  return credentialFromPool(
    payload,
    portalIdentities(payload).filter((identity) => isIhxPortal(identity)),
  );
}

export function latestRequest(requests) {
  const usable = (Array.isArray(requests) ? requests : []).filter((request) => {
    return request?.isTpa !== false && String(request?.pmjayRegistrationId ?? '').trim();
  });
  usable.sort((left, right) => {
    const leftTime = Date.parse(left?.createdAt || '') || 0;
    const rightTime = Date.parse(right?.createdAt || '') || 0;
    return rightTime - leftTime;
  });
  return usable[0] || null;
}

export async function loadIhxCredentials(client, logger = console, pmjayRegistrationId = '') {
  const requestedId = String(pmjayRegistrationId || '').trim();
  let caseId = requestedId;
  let documentType = 'ADMISSIONDOCUMENT';

  if (!caseId) {
    const body = await client.fetchRequests();
    const requests = Array.isArray(body?.requests) ? body.requests : [];
    const request = latestRequest(requests);
    if (!request) {
      logger.info?.('rpa-requests returned no cases.');
      return null;
    }
    caseId = String(request.pmjayRegistrationId).trim();
    documentType = String(request.documentType ?? '').trim() || 'ADMISSIONDOCUMENT';
    logger.info?.('Using the latest case.', { caseId });
  } else {
    logger.info?.('Using the selected case.', { caseId });
  }

  const payload = await client.fetchCaseData(caseId, documentType);
  const credential = portalCredentialFromCase(payload);
  if (!credential) {
    throw new Error(requestedId
      ? 'This case has no portal login.'
      : 'The latest case has no portal login.');
  }
  logger.info?.(`Case portal is ${credential.tpaName || 'IHX'}.`);
  return credential;
}
