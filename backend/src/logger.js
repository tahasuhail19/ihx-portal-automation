import { redact } from './redact.js';

export function createLogger() {
  function write(level, message, fields = {}) {
    const line = {
      time: new Date().toISOString(),
      level,
      message: redact(message),
    };
    const safeFields = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value == null) continue;
      safeFields[key] = typeof value === 'string' ? redact(value) : value;
    }
    const sink = level === 'error' ? console.error : console.log;
    sink(JSON.stringify({ ...line, ...safeFields }));
  }

  return {
    info(message, fields) {
      write('info', message, fields);
    },
    error(message, fields) {
      write('error', message, fields);
    },
  };
}
