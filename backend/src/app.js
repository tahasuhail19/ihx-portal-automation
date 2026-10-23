import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { tokensMatch } from './config.js';
import { httpError, redact } from './redact.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createApp(config, manager, logger) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'X-Api-Key', 'X-Session-Token'],
    maxAge: 600,
  }));

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      browserReady: true,
      viewer: 'novnc',
      loginMode: config.loginMode,
      sessionTimeoutMs: config.sessionTimeoutMs,
      maxActiveSessions: config.maxActiveSessions,
      apiKeyRequired: Boolean(config.appApiKey),
    });
  });

  app.post('/api/ihx/session', requireApiKey(config), rateLimit(), (req, res, next) => {
    try {
      res.status(201).json(manager.create());
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/ihx/session/:id', requireApiKey(config), (req, res, next) => {
    try {
      res.json(manager.get(validId(req.params.id), req.get('x-session-token')));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/ihx/session/:id/finish', requireApiKey(config), async (req, res, next) => {
    try {
      res.json(await manager.finish(validId(req.params.id), req.get('x-session-token')));
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  if (config.staticDir && fs.existsSync(config.staticDir)) {
    app.use(express.static(config.staticDir, { index: false }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) {
        next();
        return;
      }
      res.sendFile(path.join(config.staticDir, 'index.html'));
    });
  }

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Request body must be JSON.' });
      return;
    }
    const status = error.status || 500;
    if (!error.expose) {
      logger.error(redact(error.message), { status });
    }
    const message = error.expose ? redact(error.message) : 'The request could not be completed.';
    res.status(status).json({ error: message });
  });

  return app;
}

function validId(id) {
  if (!UUID.test(id || '')) throw httpError(404, 'Session not found.');
  return id;
}

function requireApiKey(config) {
  return (req, res, next) => {
    if (!config.appApiKey) {
      next();
      return;
    }
    if (!tokensMatch(config.appApiKey, req.get('x-api-key') || '')) {
      res.status(401).json({ error: 'Unauthorized.' });
      return;
    }
    next();
  };
}

function rateLimit() {
  const hits = new Map();
  return (req, res, next) => {
    const ip = req.ip || 'local';
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((time) => now - time < 60_000);
    if (recent.length >= 10) {
      res.status(429).json({ error: 'Too many session requests. Wait a minute and try again.' });
      return;
    }
    recent.push(now);
    hits.set(ip, recent);
    next();
  };
}
