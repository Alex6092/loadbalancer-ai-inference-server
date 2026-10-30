import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { configuration } from './config.js';
import { openDatabase } from './db.js';
import { Service, terminal } from './service.js';
import { Scheduler } from './scheduler.js';
import { Callbacks } from './callbacks.js';
import { registerAdmin, usageReport } from './admin.js';
import { ApiError, hash, ipAllowed, parse } from './security.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function createServer(overrides = {}) {
  const config = configuration(overrides);
  const db = openDatabase(config.database);
  const app = Fastify({
    logger:
      config.logger === true
        ? {
            redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
            serializers: {
              req: (req) => ({ method: req.method, url: req.url.split('?')[0], remoteAddress: req.ip }),
            },
          }
        : config.logger,
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimit,
    requestTimeout: 0,
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.decorate('liveResponses', new Set());
  const service = new Service(db, config);
  const scheduler = new Scheduler(service, app.log);
  const callbacks = new Callbacks(service, app.log);
  app.decorate('context', { db, config, service, scheduler, callbacks });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.secureCookies ? [] : null,
      },
    },
  });
  await app.register(rateLimit, { global: false });
  app.setErrorHandler((error, request, reply) => {
    let status = error.statusCode || 500;
    let code = error.code || 'internal_error';
    let message = error.message;
    if (error.code?.startsWith('SQLITE_CONSTRAINT')) {
      status = 409;
      code = 'conflict';
      message = 'Cet élément existe déjà ou est encore référencé.';
    }
    if (status >= 500 && !(error instanceof ApiError)) {
      message = 'Erreur interne du service.';
      app.log.error({ code: error.code, name: error.name }, 'Erreur interne');
    }
    if (status === 429 && error.details?.retry_at)
      reply.header(
        'Retry-After',
        Math.max(1, Math.ceil((Date.parse(error.details.retry_at) - Date.now()) / 1000)),
      );
    reply
      .code(status)
      .send({ error: { code, message, ...(error.details ? { details: error.details } : {}) } });
  });
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => {
    db.prepare('SELECT 1').get();
    return { status: 'ok' };
  });
  app.get('/', async (request, reply) => reply.redirect('/admin/'));
  app.get('/openapi.json', async (request, reply) => reply.sendFile('openapi.json', path.join(root, 'docs')));
  await app.register(staticFiles, {
    root: path.join(root, 'public'),
    prefix: '/admin/',
    index: ['index.html'],
  });

  await app.register(
    async (api) => {
      api.addHook('preHandler', async (request) => {
        const bearer = request.headers.authorization;
        if (typeof bearer !== 'string' || !bearer.startsWith('Bearer ') || bearer.length > 500)
          throw new ApiError(401, 'invalid_api_key', 'Clé d’API requise.');
        const key = db
          .prepare('SELECT * FROM api_keys WHERE digest = ? AND enabled = 1')
          .get(hash(bearer.slice(7)));
        const application =
          key && db.prepare('SELECT * FROM applications WHERE id = ? AND enabled = 1').get(key.app_id);
        if (!key || !application)
          throw new ApiError(401, 'invalid_api_key', 'Clé d’API invalide ou désactivée.');
        if (!ipAllowed(request.ip, parse(key.restrictions, {}).ips || []))
          throw new ApiError(403, 'ip_forbidden', 'Adresse IP non autorisée.');
        request.auth = { key, app: application };
      });
      api.post('/jobs', async (request, reply) => {
        const { job, reused } = service.submit(
          request.auth,
          request.body,
          'async',
          request.headers['x-end-user-id'],
          request.headers['idempotency-key'],
        );
        scheduler.tick();
        return reply
          .code(reused ? 200 : 202)
          .header('Location', `/v1/jobs/${job.id}`)
          .send({ ...service.publicJob(service.get(job.id)), reused });
      });
      api.get('/jobs/:id', async (request) =>
        service.publicJob(service.authorizeJob(request.auth, request.params.id)),
      );
      api.post('/jobs/:id/cancel', async (request) =>
        service.cancel(service.authorizeJob(request.auth, request.params.id)),
      );
      api.get('/models', async (request) => {
        const allowed = parse(request.auth.key.restrictions, {}).models || [];
        return {
          object: 'list',
          data: db
            .prepare('SELECT id, vision, context_tokens, max_output_tokens FROM models ORDER BY id')
            .all()
            .filter((m) => !allowed.length || allowed.includes(m.id))
            .map((m) => ({ ...m, object: 'model', owned_by: 'la-providence', vision: Boolean(m.vision) })),
        };
      });
      api.get('/workers/status', async (request) => {
        const allowed = parse(request.auth.key.restrictions, {}).models || [];
        const workers = db.prepare('SELECT * FROM workers WHERE enabled = 1').all();
        const models = db
          .prepare('SELECT id FROM models ORDER BY id')
          .all()
          .filter((m) => !allowed.length || allowed.includes(m.id));
        return {
          data: models.map((model) => {
            const compatible = workers.filter((w) => parse(w.models).includes(model.id));
            const available = compatible.filter((w) => scheduler.usable(w));
            return {
              model: model.id,
              workers: compatible.length,
              available_workers: available.length,
              capacity: available.reduce((n, w) => n + w.concurrency, 0),
              occupied: compatible.reduce((n, w) => n + scheduler.occupied(w.id), 0),
            };
          }),
          calculated_at: new Date().toISOString(),
        };
      });
      api.get('/usage', async (request) => {
        const externalId = request.headers['x-end-user-id'];
        const user =
          externalId &&
          db
            .prepare('SELECT * FROM end_users WHERE app_id = ? AND external_id = ?')
            .get(request.auth.app.id, externalId);
        const reports = service.quotas.reports({
          app_id: request.auth.app.id,
          key_id: request.auth.key.id,
          user_id: user?.id || null,
        });
        return { ...usageReport(db, config, request.query, request.auth.app.id), quotas: reports };
      });

      api.post('/chat/completions', async (request, reply) => {
        const { job } = service.submit(
          request.auth,
          request.body,
          'chat',
          request.headers['x-end-user-id'],
          request.headers['idempotency-key'],
        );
        const stream = request.body.stream === true;
        reply.header('X-Job-ID', job.id);
        reply.header('Cache-Control', 'no-cache, no-transform');
        let completed = false;
        let heartbeat;
        let resolveWait;
        let rejectWait;
        const wait = new Promise((resolve, reject) => {
          resolveWait = resolve;
          rejectWait = reject;
        });
        const cleanup = () => {
          clearInterval(heartbeat);
          service.listeners.delete(listener);
          scheduler.detach(job.id);
          app.liveResponses.delete(reply.raw);
        };
        const listener = (id) => {
          if (id !== job.id) return;
          const current = service.get(id);
          if (!terminal(current.status)) return;
          completed = true;
          cleanup();
          if (stream) {
            if (!reply.raw.destroyed) {
              if (current.status !== 'succeeded')
                reply.raw.write(
                  `data: ${JSON.stringify({ error: parse(current.error, { code: current.status, message: 'Génération interrompue.' }) })}\n\n`,
                );
              reply.raw.end('data: [DONE]\n\n');
            }
            resolveWait();
          } else if (current.status === 'succeeded') resolveWait(parse(current.result));
          else {
            const error = parse(current.error, {});
            rejectWait(
              new ApiError(
                current.status === 'expired' ? 504 : 502,
                error.code || 'generation_failed',
                error.message || 'La génération a échoué.',
                { job_id: job.id },
              ),
            );
          }
        };
        service.listeners.add(listener);
        const client = {
          stream,
          write: (data) =>
            new Promise((resolve, reject) => {
              if (reply.raw.destroyed || completed) return reject(new Error('client_disconnected'));
              if (reply.raw.write(data)) return resolve();
              const clean = () => {
                reply.raw.off('drain', drained);
                reply.raw.off('close', closed);
                reply.raw.off('error', closed);
              };
              const drained = () => {
                clean();
                resolve();
              };
              const closed = () => {
                clean();
                reject(new Error('client_disconnected'));
              };
              reply.raw.once('drain', drained);
              reply.raw.once('close', closed);
              reply.raw.once('error', closed);
            }),
        };
        scheduler.attach(job.id, client);
        reply.raw.once('close', () => {
          if (!completed) {
            cleanup();
            service.cancel(service.get(job.id));
            completed = true;
            resolveWait();
          }
        });
        app.liveResponses.add(reply.raw);
        if (stream) {
          reply.hijack();
          reply.raw.writeHead(200, {
            ...reply.getHeaders(),
            'Content-Type': 'text/event-stream; charset=utf-8',
            'X-Job-ID': job.id,
            'X-Accel-Buffering': 'no',
          });
          reply.raw.flushHeaders();
          reply.raw.write(': queued\n\n');
          heartbeat = setInterval(() => {
            if (!reply.raw.destroyed && !reply.raw.writableNeedDrain) reply.raw.write(': heartbeat\n\n');
          }, config.heartbeatMs);
          heartbeat.unref();
        }
        scheduler.tick();
        const result = await wait;
        if (!stream && !reply.raw.destroyed) return reply.send(result);
      });
    },
    { prefix: '/v1' },
  );

  await registerAdmin(app, service, scheduler, callbacks);
  let cleanupTimer;
  app.addHook('onReady', async () => {
    if (overrides.background !== false) {
      scheduler.start();
      callbacks.start();
      service.cleanup();
      cleanupTimer = setInterval(() => service.cleanup(), 60000);
      cleanupTimer.unref();
    }
  });
  app.addHook('preClose', async () => {
    clearInterval(cleanupTimer);
    for (const response of app.liveResponses) response.destroy();
    await scheduler.stop();
    await callbacks.stop();
  });
  app.addHook('onClose', async () => db.close());
  return app;
}
