const apiKey = import.meta.env.VITE_APP_API_KEY || '';

export async function getHealth() {
  return request('/api/health');
}

export async function createSession() {
  return request('/api/ihx/session', { method: 'POST' });
}

export async function getSession(id, sessionToken) {
  return request(`/api/ihx/session/${id}`, { sessionToken });
}

export async function finishSession(id, sessionToken) {
  return request(`/api/ihx/session/${id}/finish`, { method: 'POST', sessionToken });
}

async function request(path, { method = 'GET', sessionToken } = {}) {
  const headers = {};
  if (apiKey) headers['X-Api-Key'] = apiKey;
  if (sessionToken) headers['X-Session-Token'] = sessionToken;

  let response;
  try {
    response = await fetch(path, { method, headers });
  } catch {
    throw new Error('The backend is not running. Start it and refresh this page.');
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Request failed (${response.status}).`);
  }
  return body;
}
