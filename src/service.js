import { randomUUID } from 'node:crypto';
import { ApiError, hash, json, parse, callbackAllowed, stableStringify } from './security.js';
import { Quotas } from './quotas.js';

export const terminal = (status) => ['succeeded', 'failed', 'cancelled', 'expired'].includes(status);
export const millis = (value) => (value == null ? null : new Date(value).toISOString());
const publicError = (error) => ({
  code: error.code || 'generation_failed',
  message: error.message || 'La génération a échoué.',
  ...(error.details ? { details: error.details } : {}),
});

export class Service {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.quotas = new Quotas(db);
    this.listeners = new Set();
    this.queueEstimate = () => null;
    this.cancelRunning = () => {};
  }

  notify(id) {
    for (const listener of this.listeners) {
      try {
        listener(id);
      } catch {
        /* one subscriber cannot interrupt a transaction */
      }
    }
  }
  get(id) {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  }

  authorizeJob(auth, id) {
    const job = this.get(id);
    // Applications share their jobs across keys; end-user credentials never reach this API directly.
    if (!job || job.app_id !== auth.app.id) throw new ApiError(404, 'not_found', 'Job introuvable.');
    return job;
  }

  validate(body, mode, auth) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new ApiError(400, 'invalid_request', 'Objet JSON requis.');
    if (typeof body.model !== 'string') throw new ApiError(400, 'invalid_model', 'Modèle requis.');
    const model = this.db.prepare('SELECT * FROM models WHERE id = ?').get(body.model);
    if (!model) throw new ApiError(400, 'unknown_model', 'Modèle inconnu.');
    const restrictions = parse(auth.key.restrictions, {});
    if (restrictions.models?.length && !restrictions.models.includes(body.model))
      throw new ApiError(403, 'model_forbidden', 'Modèle non autorisé.');
    const accessMode = mode === 'async' ? 'async' : body.stream === true ? 'stream' : 'sync';
    if (restrictions.modes?.length && !restrictions.modes.includes(accessMode))
      throw new ApiError(403, 'mode_forbidden', 'Mode non autorisé.');
    if (body.n != null && body.n !== 1)
      throw new ApiError(400, 'unsupported_n', 'Une seule génération est autorisée (n=1).');
    if (body.stream != null && typeof body.stream !== 'boolean')
      throw new ApiError(400, 'invalid_stream', 'stream doit être un booléen.');
    if (mode === 'async' && body.stream === true)
      throw new ApiError(400, 'invalid_stream', 'Utiliser /v1/chat/completions pour le streaming.');
    if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 1000)
      throw new ApiError(
        400,
        'invalid_messages',
        'Une liste de messages non vide est requise (1000 maximum).',
      );
    let chars = 0;
    let images = 0;
    for (const message of body.messages) {
      if (
        !message ||
        !['system', 'developer', 'user', 'assistant', 'tool', 'function'].includes(message.role)
      )
        throw new ApiError(400, 'invalid_messages', 'Rôle de message invalide.');
      const content = message.content;
      if (typeof content === 'string') chars += content.length;
      else if (Array.isArray(content))
        for (const part of content) {
          if (part?.type === 'text' && typeof part.text === 'string') chars += part.text.length;
          else if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') {
            const imageUrl = part.image_url.url;
            if (!/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/.test(imageUrl)) {
              let url;
              try {
                url = new URL(imageUrl);
              } catch {
                throw new ApiError(400, 'invalid_image', 'URL d’image invalide.');
              }
              if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
                throw new ApiError(400, 'invalid_image', 'Image HTTP(S) ou data URL requise.');
            }
            images++;
          } else
            throw new ApiError(
              400,
              'unsupported_content',
              'Seuls les contenus texte et image_url sont pris en charge.',
            );
        }
      else if (content != null) throw new ApiError(400, 'invalid_messages', 'Contenu de message invalide.');
      chars += json({ ...message, content: undefined }).length;
    }
    if (images && !model.vision)
      throw new ApiError(400, 'vision_unsupported', 'Ce modèle ne prend pas en charge les images.');
    chars += json(body.tools || []).length + json(body.response_format || {}).length;
    const output = body.max_completion_tokens ?? body.max_tokens ?? model.max_output_tokens;
    if (body.max_completion_tokens != null && body.max_tokens != null)
      throw new ApiError(
        400,
        'invalid_max_tokens',
        'Fournir un seul des deux champs max_tokens et max_completion_tokens.',
      );
    if (!Number.isSafeInteger(output) || output <= 0 || output > model.max_output_tokens)
      throw new ApiError(400, 'invalid_max_tokens', 'Limite de sortie invalide.');
    const input =
      Math.ceil(chars * model.input_tokens_per_char) + images * model.image_tokens + body.messages.length * 8;
    if (input + output > model.context_tokens)
      throw new ApiError(400, 'context_length_exceeded', 'La taille estimée dépasse le contexte configuré.');
    if (body.callbackURL && mode !== 'async')
      throw new ApiError(400, 'invalid_callback', 'callbackURL est réservé aux jobs asynchrones.');
    if (
      body.callbackURL &&
      (typeof body.callbackURL !== 'string' ||
        !callbackAllowed(body.callbackURL, parse(auth.app.callback_bases, [])))
    )
      throw new ApiError(
        400,
        'callback_forbidden',
        'Destination de callback non autorisée pour cette application.',
      );
    const request = { ...body, stream: accessMode === 'stream' };
    delete request.callbackURL;
    if (body.max_completion_tokens == null && body.max_tokens == null) request.max_tokens = output;
    return { model, input, output, request };
  }

  submit(auth, body, mode, userExternal, idempotencyKey) {
    if (auth.app.require_user && !userExternal)
      throw new ApiError(400, 'user_required', 'En-tête X-End-User-ID requis.');
    if (
      userExternal != null &&
      (typeof userExternal !== 'string' || userExternal.length > 200 || !userExternal.trim())
    )
      throw new ApiError(400, 'invalid_user', 'Identifiant utilisateur invalide (200 caractères maximum).');
    if (idempotencyKey && (mode !== 'async' || idempotencyKey.length > 200))
      throw new ApiError(
        400,
        'invalid_idempotency_key',
        'Idempotency-Key est réservé aux jobs asynchrones (200 caractères maximum).',
      );
    const requestHash = hash(stableStringify({ body, userExternal: userExternal || null, mode }));
    return this.db
      .transaction(() => {
        if (idempotencyKey) {
          const existing = this.db
            .prepare('SELECT * FROM jobs WHERE key_id = ? AND idempotency_key = ?')
            .get(auth.key.id, idempotencyKey);
          if (existing) {
            if (existing.request_hash !== requestHash)
              throw new ApiError(
                409,
                'idempotency_conflict',
                'Cette clé a déjà été utilisée avec une demande différente.',
              );
            return { job: existing, reused: true };
          }
        }
        const validated = this.validate(body, mode, auth);
        const total = this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'").get().n;
        const appTotal = this.db
          .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued' AND app_id = ?")
          .get(auth.app.id).n;
        if (total >= this.config.maxQueued || appTotal >= this.config.maxQueuedPerApp)
          throw new ApiError(503, 'queue_full', 'La file d’attente est pleine. Réessayer plus tard.');
        const now = Date.now();
        let userId = null;
        if (userExternal) {
          this.db
            .prepare(
              'INSERT OR IGNORE INTO end_users(id, app_id, external_id, created_at) VALUES (?, ?, ?, ?)',
            )
            .run(randomUUID(), auth.app.id, userExternal, now);
          userId = this.db
            .prepare('SELECT id FROM end_users WHERE app_id = ? AND external_id = ?')
            .get(auth.app.id, userExternal).id;
        }
        const id = randomUUID();
        const wait = mode === 'async' ? this.config.asyncWaitMs : this.config.chatWaitMs;
        this.db
          .prepare(
            `INSERT INTO jobs(id, app_id, key_id, user_id, mode, model, request, estimated_input, estimated_output,
        callback_url, idempotency_key, request_hash, created_at, available_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            auth.app.id,
            auth.key.id,
            userId,
            mode,
            body.model,
            json(validated.request),
            validated.input,
            validated.output,
            body.callbackURL || null,
            idempotencyKey || null,
            requestHash,
            now,
            now,
            now + wait,
          );
        const job = this.get(id);
        this.quotas.reserve(job, now);
        return { job, reused: false };
      })
      .immediate();
  }

  finish(jobId, status, result = null, error = null) {
    const done = this.db
      .transaction(() => {
        const job = this.get(jobId);
        if (!job || terminal(job.status)) return false;
        const now = Date.now();
        this.db
          .prepare(
            'UPDATE jobs SET status = ?, result = ?, error = ?, finished_at = ?, active_attempt_id = NULL WHERE id = ?',
          )
          .run(
            status,
            result == null ? null : json(result),
            error == null ? null : json(publicError(error)),
            now,
            jobId,
          );
        this.quotas.release(jobId);
        if (job.callback_url) {
          const eventId = randomUUID();
          const payload = {
            id: eventId,
            type: `job.${status}`,
            created_at: millis(now),
            job_id: jobId,
            status,
            result,
            error: error ? publicError(error) : null,
          };
          this.db
            .prepare(
              'INSERT OR IGNORE INTO callbacks(id, job_id, status, payload, next_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run(eventId, jobId, 'pending', json(payload), now, now + this.config.callbackWindowMs);
        }
        return true;
      })
      .immediate();
    if (done) this.notify(jobId);
    return done;
  }

  cancel(job) {
    if (terminal(job.status)) return this.publicJob(job);
    // Abort synchronously before marking terminal. Late completion is checked against active_attempt_id.
    this.cancelRunning(job.id);
    this.finish(job.id, 'cancelled', null, { code: 'cancelled', message: 'Job annulé.' });
    return this.publicJob(this.get(job.id));
  }

  publicJob(job, includeResult = true) {
    const sums = this.db
      .prepare(
        'SELECT COALESCE(SUM(input_tokens),0) AS prompt_tokens, COALESCE(SUM(output_tokens),0) AS completion_tokens, COALESCE(MAX(estimated),0) AS estimated FROM usage WHERE job_id = ?',
      )
      .get(job.id);
    return {
      id: job.id,
      object: 'job',
      status: job.status,
      mode: job.mode,
      model: job.model,
      created_at: millis(job.created_at),
      started_at: millis(job.started_at),
      finished_at: millis(job.finished_at),
      expires_at: millis(job.expires_at),
      attempts: job.attempts,
      queue: job.status === 'queued' ? this.queueEstimate(job) : null,
      usage: {
        ...sums,
        total_tokens: sums.prompt_tokens + sums.completion_tokens,
        estimated: Boolean(sums.estimated),
      },
      ...(includeResult
        ? { result: parse(job.result), error: parse(job.error), content_expired: Boolean(job.purged_at) }
        : {}),
      links: { self: `/v1/jobs/${job.id}`, cancel: `/v1/jobs/${job.id}/cancel` },
    };
  }

  cleanup(now = Date.now()) {
    this.db
      .transaction(() => {
        const cutoff = now - this.config.retentionDays * 86400000;
        this.db
          .prepare(
            `UPDATE jobs SET request = NULL, result = NULL, error = NULL, callback_url = NULL, purged_at = ?
        WHERE finished_at < ? AND purged_at IS NULL AND NOT EXISTS (SELECT 1 FROM callbacks c WHERE c.job_id = jobs.id AND c.status = 'pending')`,
          )
          .run(now, cutoff);
        this.db
          .prepare(
            'UPDATE callbacks SET payload = NULL, last_error = NULL WHERE job_id IN (SELECT id FROM jobs WHERE purged_at IS NOT NULL)',
          )
          .run();
        this.db
          .prepare(
            'UPDATE attempts SET error = NULL WHERE job_id IN (SELECT id FROM jobs WHERE purged_at IS NOT NULL)',
          )
          .run();
        this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
      })
      .immediate();
  }
}
