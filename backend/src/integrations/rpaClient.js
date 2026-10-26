const DEFAULT_BASE_URL = 'https://apistaging.settlemed.in';

function requireEnv(env, name) {
  const value = String(env[name] ?? '').trim();
  if (!value) {
    const error = new Error(`${name} is required in .env before the case API can run.`);
    error.code = 'API_CONFIG';
    throw error;
  }
  return value;
}

function apiUrl(baseUrl, path, params) {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function statusError(label, status) {
  const error = new Error(`${label} failed with status ${status}.`);
  error.code = 'API_STATUS';
  error.status = status;
  return error;
}

export function createRpaClient({ fetchImpl = fetch, env = process.env, logger = console } = {}) {
  const baseUrl = String(env.RPA_API_BASE ?? DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  const userName = requireEnv(env, 'RPA_USERNAME');
  const password = requireEnv(env, 'RPA_PASSWORD');
  let token = '';
  let loginTask = null;

  async function readJson(response, label) {
    if (!response.ok) throw statusError(label, response.status);
    try {
      return await response.json();
    } catch (error) {
      const parseError = new Error(`${label} returned a response that was not JSON.`);
      parseError.code = 'API_RESPONSE';
      parseError.cause = error;
      throw parseError;
    }
  }

  async function call(url, init, label) {
    try {
      return await fetchImpl(url, init);
    } catch {
      throw Object.assign(new Error(`${label} request failed.`), { code: 'API_REQUEST' });
    }
  }

  async function login(forceRefresh = false) {
    if (!forceRefresh && token) return token;
    if (loginTask) return loginTask;

    loginTask = (async () => {
      const response = await call(apiUrl(baseUrl, '/rpa-login', { userName, password }), {
        method: 'GET',
        signal: AbortSignal.timeout(60_000),
      }, 'rpa-login');
      const body = await readJson(response, 'rpa-login');
      const nextToken = body?.session?.token;
      if (!nextToken) {
        throw Object.assign(new Error('rpa-login did not return a session token.'), { code: 'API_TOKEN' });
      }
      token = nextToken;
      return token;
    })().finally(() => {
      loginTask = null;
    });

    return loginTask;
  }

  async function authorizedGet(path, params, label) {
    const send = async (authToken) => {
      const response = await call(apiUrl(baseUrl, path, params), {
        method: 'GET',
        headers: { 'rpa-auth-token': authToken },
        signal: AbortSignal.timeout(60_000),
      }, label);
      return readJson(response, label);
    };

    try {
      return await send(await login(false));
    } catch (error) {
      if (error?.status === 401) {
        logger.info?.(`${label} returned 401. Refreshing the auth token and retrying once.`);
        return send(await login(true));
      }
      logger.info?.(`${label} failed. Retrying once.`);
      return send(await login(false));
    }
  }

  return {
    login,
    fetchRequests() {
      return authorizedGet('/rpa-requests', { isTpa: 1, isRpa: true }, 'rpa-requests');
    },
    fetchCaseData(pmjayRegistrationId, documentType = 'ADMISSIONDOCUMENT') {
      return authorizedGet(
        '/tpa-case-data',
        { pmjayRegistrationId, documentType, isRpa: true },
        'tpa-case-data',
      );
    },
  };
}
