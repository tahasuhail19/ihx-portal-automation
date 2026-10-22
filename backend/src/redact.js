const SECRET_PATTERNS = [
  /token=[^&\s]+/gi,
  /wss?:\/\/\S+/gi,
  /https?:\/\/[^\s]*browserless[^\s]*/gi,
  /(password|passwd|pwd)\s*[=:]\s*\S+/gi,
  /(authorization|api[-_]?key|session[-_]?token|cookie)\s*[:=]\s*\S+/gi,
];

export function redact(value) {
  let text = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, '[redacted]');
  }
  return text;
}

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}
