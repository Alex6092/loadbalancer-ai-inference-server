import { randomUUID } from 'node:crypto';
import {
  ApiError,
  opaque,
  hash,
  encrypt,
  json,
  parse,
  passwordMatches,
  passwordHash,
  httpUrl,
  validNetworks,
} from './security.js';
import { normalizePolicy } from './quotas.js';

const integer = (value, name, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new ApiError(400, 'invalid_field', `${name} doit être un entier entre ${min} et ${max}.`);
  return value;
};
const text = (value, name, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new ApiError(400, 'invalid_field', `${name} invalide.`);
  return value.trim();
};
function bool(value, fallback = true) {
  if (value == null) return fallback ? 1 : 0;
  if (typeof value !== 'boolean') throw new ApiError(400, 'invalid_field', 'Booléen requis.');
  return value ? 1 : 0;
}
function strings(value, name) {
  if (
    !Array.isArray(value) ||
    value.length > 200 ||
    !value.every((s) => typeof s === 'string' && s.length > 0 && s.length < 1000)
  )
    throw new ApiError(400, 'invalid_field', `${name} : liste de chaînes requise.`);
  return [...new Set(value)];
}

export async function registerAdmin(app, service, scheduler, callbacks) {
  const { db, config } = service;
  const audit = (request, action, target = null) =>
    db
      .prepare('INSERT INTO audit(admin_id, action, target, created_at) VALUES (?, ?, ?, ?)')
      .run(request.admin.id, action, target, Date.now());
  const requireRow = (table, id) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!row) throw new ApiError(404, 'not_found', 'Élément introuvable.');
    return row;
  };
  const showApp = (row) => ({
    ...row,
    enabled: Boolean(row.enabled),
    require_user: Boolean(row.require_user),
    policy: parse(row.policy),
    default_user_policy: parse(row.default_user_policy),
    callback_bases: parse(row.callback_bases),
    callback_secret: undefined,
    has_callback_secret: Boolean(row.callback_secret),
  });
  const showKey = (row) => ({
    ...row,
    digest: undefined,
    restrictions: parse(row.restrictions),
    policy: parse(row.policy),
    enabled: Boolean(row.enabled),
  });
  const showWorker = (row) => ({
    ...row,
    secret: undefined,
    has_secret: Boolean(row.secret),
    models: parse(row.models),
    enabled: Boolean(row.enabled),
    occupied: scheduler.occupied(row.id),
    uncertain: db
      .prepare("SELECT COUNT(*) AS n FROM attempts WHERE worker_id = ? AND status = 'uncertain'")
      .get(row.id).n,
  });

  await app.register(
    async (admin) => {
      admin.addHook('preHandler', async (request) => {
        if (request.routeOptions.config.public) return;
        const token = request.cookies.session;
        const session =
          token &&
          db
            .prepare(
              'SELECT s.*, a.id AS account_id, a.username FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.digest = ? AND s.expires_at > ?',
            )
            .get(hash(token), Date.now());
        if (!session) throw new ApiError(401, 'admin_auth_required', 'Connexion administrateur requise.');
        request.admin = { id: session.account_id, username: session.username, session };
        if (!['GET', 'HEAD'].includes(request.method) && request.headers['x-csrf-token'] !== session.csrf)
          throw new ApiError(403, 'csrf_failed', 'Jeton CSRF manquant ou invalide.');
      });

      admin.post(
        '/login',
        { config: { public: true, rateLimit: { max: 10, timeWindow: '15 minutes' } } },
        async (request, reply) => {
          const { username, password } = request.body || {};
          if (typeof username !== 'string' || typeof password !== 'string' || password.length > 256)
            throw new ApiError(401, 'invalid_credentials', 'Identifiants invalides.');
          const account = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
          // Always perform scrypt to avoid an inexpensive username-existence oracle.
          const valid = await passwordMatches(
            password,
            account?.password || `${'0'.repeat(22)}:${'0'.repeat(128)}`,
          );
          if (!account || !valid) throw new ApiError(401, 'invalid_credentials', 'Identifiants invalides.');
          if (request.cookies.session)
            db.prepare('DELETE FROM sessions WHERE digest = ?').run(hash(request.cookies.session));
          const token = opaque();
          const csrf = opaque();
          db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(
            hash(token),
            account.id,
            csrf,
            Date.now() + 12 * 3600000,
          );
          reply.setCookie('session', token, {
            httpOnly: true,
            sameSite: 'strict',
            secure: config.secureCookies,
            path: '/admin',
            maxAge: 43200,
          });
          db.prepare('INSERT INTO audit(admin_id, action, target, created_at) VALUES (?, ?, ?, ?)').run(
            account.id,
            'login',
            account.id,
            Date.now(),
          );
          return { username: account.username, csrf };
        },
      );
      admin.get('/me', async (request) => ({
        username: request.admin.username,
        csrf: request.admin.session.csrf,
      }));
      admin.post('/logout', async (request, reply) => {
        db.prepare('DELETE FROM sessions WHERE digest = ?').run(request.admin.session.digest);
        reply.clearCookie('session', { path: '/admin' });
        return { ok: true };
      });
      admin.get('/snapshot', async () => ({
        counts: db.prepare('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status').all(),
        applications: db.prepare('SELECT * FROM applications ORDER BY name').all().map(showApp),
        keys: db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all().map(showKey),
        models: db
          .prepare('SELECT * FROM models ORDER BY id')
          .all()
          .map((m) => ({ ...m, vision: Boolean(m.vision) })),
        workers: db.prepare('SELECT * FROM workers ORDER BY name').all().map(showWorker),
        jobs: db
          .prepare(
            `SELECT j.id, j.app_id, j.key_id, j.user_id, u.external_id, j.mode, j.model, j.status, j.attempts,
        j.created_at, j.started_at, j.finished_at, a.worker_id FROM jobs j LEFT JOIN end_users u ON u.id = j.user_id
        LEFT JOIN attempts a ON a.id = j.active_attempt_id ORDER BY CASE WHEN j.status IN ('queued','running') THEN 0 ELSE 1 END, j.seq DESC LIMIT 200`,
          )
          .all(),
        callbacks: db
          .prepare(
            'SELECT id, job_id, status, attempts, next_at, last_status, last_error, delivered_at FROM callbacks ORDER BY rowid DESC LIMIT 100',
          )
          .all(),
        audit: db
          .prepare(
            'SELECT a.*, ad.username FROM audit a LEFT JOIN admins ad ON a.admin_id = ad.id ORDER BY a.id DESC LIMIT 100',
          )
          .all(),
      }));

      admin.get('/jobs', async (request) => {
        const limit = Math.min(200, Math.max(1, Math.floor(Number(request.query.limit) || 100)));
        const offset = Math.max(0, Math.floor(Number(request.query.offset) || 0));
        const { status = '', model = '', app_id: appId = '', search = '' } = request.query;
        const where = `(? = '' OR j.status = ?) AND (? = '' OR j.model = ?) AND (? = '' OR j.app_id = ?) AND (? = '' OR j.id LIKE ?)`;
        const values = [status, status, model, model, appId, appId, search, `${search}%`];
        const total = db.prepare(`SELECT COUNT(*) AS n FROM jobs j WHERE ${where}`).get(...values).n;
        const data = db
          .prepare(
            `SELECT j.id, j.app_id, j.key_id, j.user_id, u.external_id, j.mode, j.model, j.status, j.attempts,
        j.created_at, j.started_at, j.finished_at, a.worker_id FROM jobs j LEFT JOIN end_users u ON u.id = j.user_id
        LEFT JOIN attempts a ON a.id = j.active_attempt_id WHERE ${where} ORDER BY j.seq DESC LIMIT ? OFFSET ?`,
          )
          .all(...values, limit, offset);
        return { data, total, limit, offset };
      });

      admin.get('/events', async (request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        });
        const timer = setInterval(() => {
          if (request.admin.session.expires_at < Date.now()) return reply.raw.end();
          if (!reply.raw.writableNeedDrain) reply.raw.write('data: {"type":"refresh"}\n\n');
        }, 2000);
        timer.unref();
        app.liveResponses.add(reply.raw);
        reply.raw.on('close', () => {
          clearInterval(timer);
          app.liveResponses.delete(reply.raw);
        });
        reply.raw.write('data: {"type":"refresh"}\n\n');
      });

      const applicationValues = (body) => {
        const bases = strings(body.callback_bases || [], 'callback_bases');
        for (const base of bases)
          if (httpUrl(base).search)
            throw new ApiError(
              400,
              'invalid_url',
              'Les bases de callback ne doivent pas contenir de paramètres.',
            );
        return [
          text(body.name, 'name'),
          bool(body.enabled),
          bool(body.require_user),
          json(normalizePolicy(body.policy)),
          json(normalizePolicy(body.default_user_policy)),
          json(bases),
        ];
      };
      admin.post('/applications', async (request) => {
        const id = randomUUID();
        const secret = opaque();
        db.prepare(
          'INSERT INTO applications(id, name, enabled, require_user, policy, default_user_policy, callback_bases, callback_secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          id,
          ...applicationValues(request.body || {}),
          encrypt(secret, config.encryptionKey),
          Date.now(),
        );
        audit(request, 'application.create', id);
        return { ...showApp(requireRow('applications', id)), callback_secret: secret };
      });
      admin.put('/applications/:id', async (request) => {
        requireRow('applications', request.params.id);
        db.prepare(
          'UPDATE applications SET name = ?, enabled = ?, require_user = ?, policy = ?, default_user_policy = ?, callback_bases = ? WHERE id = ?',
        ).run(...applicationValues(request.body || {}), request.params.id);
        audit(request, 'application.update', request.params.id);
        return showApp(requireRow('applications', request.params.id));
      });
      admin.post('/applications/:id/rotate-callback-secret', async (request) => {
        requireRow('applications', request.params.id);
        const secret = opaque();
        db.prepare('UPDATE applications SET callback_secret = ? WHERE id = ?').run(
          encrypt(secret, config.encryptionKey),
          request.params.id,
        );
        audit(request, 'application.rotate-callback-secret', request.params.id);
        return { callback_secret: secret };
      });

      const keyValues = (body) => {
        const r = body.restrictions || {};
        const models = strings(r.models || [], 'models');
        const modes = strings(r.modes || [], 'modes');
        if (modes.some((m) => !['async', 'sync', 'stream'].includes(m)))
          throw new ApiError(400, 'invalid_mode', 'Mode invalide.');
        const ips = r.ips || [];
        if (!validNetworks(ips)) throw new ApiError(400, 'invalid_ip', 'Adresse IP ou réseau CIDR invalide.');
        return [
          text(body.name, 'name'),
          bool(body.enabled),
          json({ models, modes, ips }),
          json(normalizePolicy(body.policy)),
        ];
      };
      admin.post('/applications/:id/keys', async (request) => {
        requireRow('applications', request.params.id);
        const id = randomUUID();
        const secret = `lp_${opaque()}`;
        const values = keyValues(request.body || {});
        db.prepare(
          'INSERT INTO api_keys(id, app_id, name, enabled, restrictions, policy, prefix, digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(id, request.params.id, ...values, secret.slice(0, 11), hash(secret), Date.now());
        audit(request, 'key.create', id);
        return { ...showKey(requireRow('api_keys', id)), api_key: secret };
      });
      admin.put('/keys/:id', async (request) => {
        requireRow('api_keys', request.params.id);
        db.prepare(
          'UPDATE api_keys SET name = ?, enabled = ?, restrictions = ?, policy = ? WHERE id = ?',
        ).run(...keyValues(request.body || {}), request.params.id);
        audit(request, 'key.update', request.params.id);
        return showKey(requireRow('api_keys', request.params.id));
      });
      admin.post('/keys/:id/rotate', async (request) => {
        requireRow('api_keys', request.params.id);
        const secret = `lp_${opaque()}`;
        db.prepare('UPDATE api_keys SET digest = ?, prefix = ? WHERE id = ?').run(
          hash(secret),
          secret.slice(0, 11),
          request.params.id,
        );
        audit(request, 'key.rotate', request.params.id);
        return { api_key: secret };
      });

      admin.get('/users', async (request) => {
        const limit = Math.min(500, Math.max(1, Math.floor(Number(request.query.limit) || 100)));
        const offset = Math.max(0, Math.floor(Number(request.query.offset) || 0));
        const appId = request.query.app_id || '';
        return {
          data: db
            .prepare(
              "SELECT * FROM end_users WHERE (? = '' OR app_id = ?) ORDER BY created_at DESC LIMIT ? OFFSET ?",
            )
            .all(appId, appId, limit, offset)
            .map((u) => ({ ...u, policy: parse(u.policy) })),
          offset,
          limit,
        };
      });
      admin.put('/users/:id', async (request) => {
        requireRow('end_users', request.params.id);
        const policy = request.body?.policy == null ? null : json(normalizePolicy(request.body.policy));
        db.prepare('UPDATE end_users SET policy = ? WHERE id = ?').run(policy, request.params.id);
        audit(request, 'user.policy', request.params.id);
        return { ok: true };
      });
      admin.post('/credits', async (request) => {
        const { scope, scope_id: scopeId, tokens, note } = request.body || {};
        const table = { application: 'applications', key: 'api_keys', user: 'end_users' }[scope];
        if (!table) throw new ApiError(400, 'invalid_scope', 'Périmètre invalide.');
        requireRow(table, scopeId);
        db.prepare('INSERT INTO credits VALUES (?, ?, ?, ?, ?, ?)').run(
          randomUUID(),
          scope,
          scopeId,
          integer(tokens, 'tokens', 1, 1e12),
          text(note, 'note', 500),
          Date.now(),
        );
        audit(request, 'quota.credit', `${scope}:${scopeId}`);
        return { ok: true };
      });

      const modelValues = (body) => {
        const context = integer(body.context_tokens, 'context_tokens', 128, 10000000);
        const output = integer(body.max_output_tokens, 'max_output_tokens', 1, context - 1);
        const ratio = body.input_tokens_per_char ?? 1;
        if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 10)
          throw new ApiError(400, 'invalid_estimate', 'Ratio d’estimation invalide.');
        return [
          context,
          output,
          ratio,
          integer(body.image_tokens ?? 8192, 'image_tokens', 1, 10000000),
          bool(body.vision, false),
        ];
      };
      admin.post('/models', async (request) => {
        const body = request.body || {};
        const id = text(body.id, 'id');
        db.prepare('INSERT INTO models VALUES (?, ?, ?, ?, ?, ?)').run(id, ...modelValues(body));
        audit(request, 'model.create', id);
        return { id };
      });
      admin.put('/models/:id', async (request) => {
        requireRow('models', request.params.id);
        db.prepare(
          'UPDATE models SET context_tokens = ?, max_output_tokens = ?, input_tokens_per_char = ?, image_tokens = ?, vision = ? WHERE id = ?',
        ).run(...modelValues(request.body || {}), request.params.id);
        audit(request, 'model.update', request.params.id);
        return { ok: true };
      });

      const workerValues = (body, old) => {
        const url = httpUrl(text(body.url, 'url', 2000));
        if (url.search)
          throw new ApiError(400, 'invalid_url', 'L’URL du worker ne doit pas contenir de paramètres.');
        const models = strings(body.models || [], 'models');
        if (!models.length || models.some((id) => !db.prepare('SELECT 1 FROM models WHERE id = ?').get(id)))
          throw new ApiError(400, 'unknown_model', 'Déclarer au moins un modèle existant.');
        if (body.secret != null && (typeof body.secret !== 'string' || body.secret.length > 10000))
          throw new ApiError(400, 'invalid_secret', 'Secret invalide.');
        return [
          text(body.name, 'name'),
          url.toString().replace(/\/$/, ''),
          body.secret == null ? old?.secret || null : encrypt(body.secret, config.encryptionKey),
          json(models),
          integer(body.concurrency ?? 1, 'concurrency', 1, 100),
          bool(body.enabled),
        ];
      };
      admin.post('/workers', async (request) => {
        const id = randomUUID();
        db.prepare(
          'INSERT INTO workers(id, name, url, secret, models, concurrency, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(id, ...workerValues(request.body || {}), Date.now());
        audit(request, 'worker.create', id);
        void scheduler.probe(requireRow('workers', id));
        return showWorker(requireRow('workers', id));
      });
      admin.put('/workers/:id', async (request) => {
        const old = requireRow('workers', request.params.id);
        const values = workerValues(request.body || {}, old);
        const occupied = scheduler.occupied(old.id);
        if (occupied && (values[1] !== old.url || values[2] !== old.secret || values[3] !== old.models))
          throw new ApiError(
            409,
            'worker_busy',
            'Mettre le worker en maintenance et attendre la fin des tentatives avant de modifier son URL, son secret ou ses modèles.',
          );
        db.prepare(
          "UPDATE workers SET name = ?, url = ?, secret = ?, models = ?, concurrency = ?, enabled = ?, status = 'checking' WHERE id = ?",
        ).run(...values, old.id);
        audit(request, 'worker.update', old.id);
        if (values[5]) void scheduler.probe(requireRow('workers', old.id));
        return showWorker(requireRow('workers', old.id));
      });
      admin.post('/workers/:id/probe', async (request) => {
        await scheduler.probe(requireRow('workers', request.params.id));
        audit(request, 'worker.probe', request.params.id);
        return showWorker(requireRow('workers', request.params.id));
      });
      admin.post('/workers/:id/release-uncertain', async (request) => {
        requireRow('workers', request.params.id);
        if (request.body?.confirmed_remote_stopped !== true)
          throw new ApiError(
            400,
            'confirmation_required',
            'Vérifier l’arrêt distant puis fournir confirmed_remote_stopped=true.',
          );
        db.prepare(
          "UPDATE attempts SET status = 'abandoned', hold_until = NULL WHERE worker_id = ? AND status = 'uncertain'",
        ).run(request.params.id);
        audit(request, 'worker.release-uncertain', request.params.id);
        return { ok: true };
      });

      admin.get('/jobs/:id', async (request) => {
        const job = requireRow('jobs', request.params.id);
        // Only explicit inspection reads content; never include request bodies in the live snapshot.
        audit(request, 'job.inspect', job.id);
        return {
          ...service.publicJob(job),
          request: parse(job.request),
          reservations: db.prepare('SELECT * FROM reservations WHERE job_id = ?').all(job.id),
          attempts_detail: db
            .prepare('SELECT * FROM attempts WHERE job_id = ? ORDER BY started_at')
            .all(job.id),
        };
      });
      admin.post('/jobs/:id/cancel', async (request) => {
        const job = requireRow('jobs', request.params.id);
        audit(request, 'job.cancel', job.id);
        return service.cancel(job);
      });
      admin.post('/callbacks/:id/retry', async (request) => {
        const callback = requireRow('callbacks', request.params.id);
        if (!callback.payload) throw new ApiError(410, 'content_expired', 'Le contenu a expiré.');
        db.prepare("UPDATE callbacks SET status = 'pending', next_at = ?, expires_at = ? WHERE id = ?").run(
          Date.now(),
          Date.now() + config.callbackWindowMs,
          callback.id,
        );
        audit(request, 'callback.retry', callback.id);
        return { ok: true };
      });

      admin.get('/usage', async (request) => usageReport(db, config, request.query));
      admin.get('/quotas', async (request) => {
        const { app_id: appId, key_id: keyId, user_id: userId } = request.query;
        const application = requireRow('applications', appId);
        const reports = [service.quotas.report('application', appId, parse(application.policy))];
        if (keyId) {
          const key = requireRow('api_keys', keyId);
          if (key.app_id !== appId) throw new ApiError(400, 'invalid_scope', 'Clé d’une autre application.');
          reports.push(service.quotas.report('key', keyId, parse(key.policy)));
        }
        if (userId) {
          const user = requireRow('end_users', userId);
          if (user.app_id !== appId)
            throw new ApiError(400, 'invalid_scope', 'Utilisateur d’une autre application.');
          reports.push(
            service.quotas.report('user', userId, parse(user.policy ?? application.default_user_policy)),
          );
        }
        return { data: reports };
      });
      admin.get('/accounts', async () => ({
        data: db.prepare('SELECT id, username, created_at FROM admins ORDER BY username').all(),
      }));
      admin.post('/accounts', async (request) => {
        const id = randomUUID();
        const username = text(request.body?.username, 'username');
        const password = await passwordHash(request.body?.password);
        db.prepare('INSERT INTO admins VALUES (?, ?, ?, ?)').run(id, username, password, Date.now());
        audit(request, 'admin.create', id);
        return { id, username };
      });
      admin.put('/accounts/:id/password', async (request) => {
        requireRow('admins', request.params.id);
        const password = await passwordHash(request.body?.password);
        db.transaction(() => {
          db.prepare('UPDATE admins SET password = ? WHERE id = ?').run(password, request.params.id);
          db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(request.params.id);
          audit(request, 'admin.password', request.params.id);
        }).immediate();
        return { ok: true };
      });
    },
    { prefix: '/admin/api' },
  );
}

export function usageReport(db, config, query, appId = null) {
  const oldest = Date.now() - config.statisticsDays * 86400000;
  const since = query.since ? Date.parse(query.since) : Math.max(oldest, Date.now() - 30 * 86400000);
  const until = query.until ? Date.parse(query.until) : Date.now();
  if (!Number.isFinite(since) || !Number.isFinite(until) || since < oldest || until < since)
    throw new ApiError(400, 'invalid_period', 'Période invalide ou hors conservation statistique.');
  const group = query.group || 'application';
  const groupColumns = {
    application: 'app_id',
    key: 'key_id',
    user: 'user_id',
    model: 'model',
    day: "strftime('%Y-%m-%d', created_at / 1000, 'unixepoch')",
  };
  const column = groupColumns[group];
  if (!column) throw new ApiError(400, 'invalid_group', 'Regroupement invalide.');
  const filterApp = appId || query.app_id || '';
  const rows = db
    .prepare(
      `SELECT ${column} AS dimension, SUM(input_tokens) AS prompt_tokens, SUM(output_tokens) AS completion_tokens,
    COUNT(*) AS attempts, SUM(estimated) AS estimated_attempts FROM usage
    WHERE created_at >= ? AND created_at <= ? AND (? = '' OR app_id = ?) AND (? = '' OR key_id = ?) AND (? = '' OR user_id = ?)
    GROUP BY ${column} ORDER BY prompt_tokens + completion_tokens DESC LIMIT 1000`,
    )
    .all(
      since,
      until,
      filterApp,
      filterApp,
      query.key_id || '',
      query.key_id || '',
      query.user_id || '',
      query.user_id || '',
    );
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString(), group, data: rows };
}
