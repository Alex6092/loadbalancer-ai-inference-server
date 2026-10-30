import { randomUUID } from 'node:crypto';
import { ApiError, decrypt, json, parse } from './security.js';
import { terminal } from './service.js';

const waitError = (code, message) => ({ code, message });

function rotatePick(values, previous) {
  const unique = [...new Set(values)].sort();
  return unique.find((v) => v > (previous || '')) || unique[0];
}

export function chooseJob(jobs, state) {
  if (!jobs.length) return null;
  const chats = jobs.filter((j) => j.mode === 'chat');
  const asyncJobs = jobs.filter((j) => j.mode === 'async');
  const mode = chats.length && (!asyncJobs.length || state.streak < 3) ? 'chat' : 'async';
  const candidates = mode === 'chat' ? chats : asyncJobs;
  const app = rotatePick(
    candidates.map((j) => j.app_id),
    state.apps[mode],
  );
  const userKey = `${mode}:${app}`;
  const user = rotatePick(
    candidates.filter((j) => j.app_id === app).map((j) => j.user_id || ''),
    state.users[userKey],
  );
  const job = candidates.find((j) => j.app_id === app && (j.user_id || '') === user);
  state.streak = mode === 'chat' ? Math.min(3, state.streak + 1) : 0;
  state.apps[mode] = app;
  state.users[userKey] = user;
  return job;
}

export class Scheduler {
  constructor(service, logger) {
    this.service = service;
    this.db = service.db;
    this.config = service.config;
    this.log = logger;
    this.running = new Map();
    this.clients = new Map();
    this.probing = new Set();
    this.stopping = false;
    this.ticking = false;
    service.queueEstimate = (job) => this.estimate(job);
    service.cancelRunning = (id) => this.abort(id);
  }

  state() {
    return parse(this.db.prepare("SELECT value FROM scheduler_state WHERE name = 'fairness'").get()?.value, {
      streak: 0,
      apps: {},
      users: {},
    });
  }

  occupied(workerId, now = Date.now()) {
    return this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM attempts WHERE worker_id = ? AND (status = 'running' OR status = 'uncertain')",
      )
      .get(workerId).n;
  }

  usable(worker, now = Date.now()) {
    return Boolean(
      worker.enabled &&
      worker.status === 'available' &&
      !this.db
        .prepare("SELECT 1 FROM attempts WHERE worker_id = ? AND status = 'uncertain' AND hold_until <= ?")
        .get(worker.id, now),
    );
  }

  estimate(job) {
    const now = Date.now();
    const workers = this.db
      .prepare('SELECT * FROM workers WHERE enabled = 1')
      .all()
      .filter((w) => parse(w.models).includes(job.model));
    const available = workers.filter((w) => this.usable(w, now));
    const jobs = this.db
      .prepare("SELECT * FROM jobs WHERE status = 'queued' AND model = ? AND available_at <= ? ORDER BY seq")
      .all(job.model, now);
    const state = this.state();
    let ahead = 0;
    while (jobs.length) {
      const next = chooseJob(jobs, state);
      if (next.id === job.id) break;
      jobs.splice(
        jobs.findIndex((j) => j.id === next.id),
        1,
      );
      ahead++;
    }
    return {
      estimated_jobs_ahead: job.available_at > now ? null : ahead,
      running_for_model: this.db
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE model = ? AND status = 'running'")
        .get(job.model).n,
      reason:
        job.available_at > now ? 'retry_backoff' : !available.length ? 'workers_unavailable' : 'capacity',
      calculated_at: new Date(now).toISOString(),
      estimate: true,
    };
  }

  attach(jobId, client) {
    this.clients.set(jobId, client);
  }
  detach(jobId) {
    this.clients.delete(jobId);
  }

  abort(jobId) {
    const run = this.running.get(jobId);
    if (run) {
      run.cancelled = true;
      run.controller.abort(new Error('cancelled'));
    }
  }

  recover() {
    const now = Date.now();
    this.db
      .transaction(() => {
        // A lost HTTP connection cannot prove that a remote generation has stopped.
        const active = this.db.prepare("SELECT * FROM attempts WHERE status = 'running'").all();
        for (const attempt of active) {
          this.db
            .prepare(
              "UPDATE attempts SET status = 'uncertain', hold_until = ?, finished_at = ?, error = 'service_restarted' WHERE id = ?",
            )
            .run(attempt.deadline, now, attempt.id);
          const job = this.service.get(attempt.job_id);
          this.service.quotas.record(
            job,
            attempt.id,
            { prompt_tokens: job.estimated_input, completion_tokens: job.estimated_output, estimated: true },
            now,
          );
        }
        this.db.prepare("UPDATE workers SET status = 'checking'").run();
        for (const job of this.db.prepare("SELECT * FROM jobs WHERE status = 'running'").all()) {
          if (job.mode === 'async' && job.attempts < this.config.maxAttempts) {
            this.db
              .prepare(
                "UPDATE jobs SET status = 'queued', active_attempt_id = NULL, available_at = ? WHERE id = ?",
              )
              .run(now + 1000, job.id);
          } else
            this.service.finish(
              job.id,
              'failed',
              null,
              waitError('service_restarted', 'Le service a redémarré pendant la génération.'),
            );
        }
      })
      .immediate();
  }

  start() {
    this.recover();
    this.timer = setInterval(() => this.tick(), this.config.tickMs);
    this.probeTimer = setInterval(() => this.probeAll(), this.config.probeIntervalMs);
    this.timer.unref();
    this.probeTimer.unref();
    this.probeAll();
    this.tick();
  }

  async probeAll() {
    if (this.stopping) return;
    await Promise.all(
      this.db
        .prepare('SELECT * FROM workers WHERE enabled = 1')
        .all()
        .map((w) => this.probe(w)),
    );
  }

  async probe(worker) {
    if (this.probing.has(worker.id) || this.stopping) return;
    this.probing.add(worker.id);
    try {
      const response = await fetch(`${worker.url.replace(/\/$/, '')}/models`, {
        headers: this.headers(worker),
        signal: AbortSignal.timeout(this.config.probeTimeoutMs),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await this.readJson(response, 1024 * 1024);
      if (
        !Array.isArray(body.data) ||
        !parse(worker.models).every((id) => body.data.some((m) => m.id === id))
      )
        throw new Error('Catalogue des modèles incomplet.');
      this.db
        .prepare(
          "UPDATE workers SET status = 'available', failures = 0, error = NULL, last_check = ?, last_success = ? WHERE id = ?",
        )
        .run(Date.now(), Date.now(), worker.id);
    } catch {
      // Do not record response bodies or URLs containing sensitive query parameters.
      this.db
        .prepare(
          "UPDATE workers SET status = 'unavailable', failures = failures + 1, error = 'Échec du contrôle HTTP ou du catalogue', last_check = ? WHERE id = ?",
        )
        .run(Date.now(), worker.id);
    } finally {
      this.probing.delete(worker.id);
    }
  }

  headers(worker) {
    const secret = decrypt(worker.secret, this.config.encryptionKey);
    return { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) };
  }

  tick() {
    if (this.stopping || this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      for (const job of this.db
        .prepare("SELECT * FROM jobs WHERE status = 'queued' AND expires_at <= ?")
        .all(now)) {
        this.service.finish(
          job.id,
          'expired',
          null,
          waitError('queue_timeout', 'Délai maximal d’attente dépassé.'),
        );
      }
      let dispatched = 0;
      while (dispatched < 100) {
        const assignment = this.claim();
        if (!assignment) break;
        dispatched++;
        void this.execute(assignment).catch((error) =>
          this.log.error({ err: { message: error.message } }, 'Erreur interne du traitement'),
        );
      }
    } catch (error) {
      this.log.error({ err: { message: error.message } }, 'Erreur ordonnanceur');
    } finally {
      this.ticking = false;
    }
  }

  claim() {
    return this.db
      .transaction(() => {
        const now = Date.now();
        const workers = this.db
          .prepare("SELECT * FROM workers WHERE enabled = 1 AND status = 'available'")
          .all()
          .filter(
            (w) =>
              !this.db
                .prepare(
                  "SELECT 1 FROM attempts WHERE worker_id = ? AND status = 'uncertain' AND hold_until <= ?",
                )
                .get(w.id, now),
          )
          .map((w) => ({ ...w, occupied: this.occupied(w.id) }))
          .filter((w) => w.occupied < w.concurrency);
        if (!workers.length) return null;
        const waiting = this.db
          .prepare(
            "SELECT * FROM jobs WHERE status = 'queued' AND available_at <= ? AND expires_at > ? ORDER BY seq",
          )
          .all(now, now);
        const candidates = waiting.filter(
          (job) =>
            workers.some((w) => parse(w.models).includes(job.model)) &&
            (job.mode !== 'chat' || this.clients.has(job.id)),
        );
        const state = this.state();
        for (;;) {
          const job = chooseJob(candidates, state);
          if (!job) return null;
          const app = this.db.prepare('SELECT enabled FROM applications WHERE id = ?').get(job.app_id);
          const key = this.db.prepare('SELECT enabled FROM api_keys WHERE id = ?').get(job.key_id);
          try {
            if (!app.enabled || !key.enabled)
              throw new ApiError(403, 'key_disabled', 'Application ou clé désactivée.');
            this.service.quotas.reserve(job, now);
          } catch (error) {
            this.service.finish(job.id, 'failed', null, error);
            candidates.splice(
              candidates.findIndex((j) => j.id === job.id),
              1,
            );
            continue;
          }
          const worker = workers
            .filter((w) => parse(w.models).includes(job.model))
            .sort(
              (a, b) => a.occupied / a.concurrency - b.occupied / b.concurrency || a.id.localeCompare(b.id),
            )[0];
          const attemptId = randomUUID();
          const deadline = now + this.config.attemptTimeoutMs;
          this.db
            .prepare(
              "INSERT INTO attempts(id, job_id, worker_id, status, started_at, deadline) VALUES (?, ?, ?, 'running', ?, ?)",
            )
            .run(attemptId, job.id, worker.id, now, deadline);
          this.db
            .prepare(
              "UPDATE jobs SET status = 'running', active_attempt_id = ?, attempts = attempts + 1, started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'queued'",
            )
            .run(attemptId, now, job.id);
          this.db.prepare("INSERT OR REPLACE INTO scheduler_state VALUES ('fairness', ?)").run(json(state));
          this.service.notify(job.id);
          return { job: this.service.get(job.id), worker, attemptId, deadline };
        }
      })
      .immediate();
  }

  async readJson(response, limit = this.config.bodyLimit) {
    const reader = response.body.getReader();
    const buffers = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) throw new Error('Réponse du worker trop volumineuse.');
        buffers.push(value);
      }
      return JSON.parse(Buffer.concat(buffers).toString('utf8'));
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  validUsage(usage) {
    return (
      usage &&
      Number.isSafeInteger(usage.prompt_tokens) &&
      usage.prompt_tokens >= 0 &&
      Number.isSafeInteger(usage.completion_tokens) &&
      usage.completion_tokens >= 0
    );
  }

  async execute({ job, worker, attemptId, deadline }) {
    const controller = new AbortController();
    const run = { controller, cancelled: false, exposed: false, received: false, characters: 0 };
    this.running.set(job.id, run);
    const timer = setTimeout(
      () => controller.abort(new Error('attempt_timeout')),
      Math.max(1, deadline - Date.now()),
    );
    timer.unref();
    let usage;
    let result;
    let failure;
    let uncertain = false;
    let retryable = true;
    let response;
    try {
      const request = parse(job.request);
      if (request.stream) request.stream_options = { ...request.stream_options, include_usage: true };
      response = await fetch(`${worker.url.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: this.headers(worker),
        body: json(request),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        retryable = response.status >= 500 || [408, 429].includes(response.status);
        await response.body?.cancel();
        throw new ApiError(
          502,
          `worker_http_${response.status}`,
          `Le worker a renvoyé HTTP ${response.status}.`,
        );
      }
      if (request.stream) {
        ({ result, usage } = await this.consumeStream(response, job, run));
      } else {
        result = await this.readJson(response);
        if (!Array.isArray(result.choices) || !result.choices.length)
          throw new Error('Réponse du worker invalide.');
        if (this.validUsage(result.usage)) usage = { ...result.usage, estimated: false };
        else
          usage = {
            prompt_tokens: job.estimated_input,
            completion_tokens: Math.min(job.estimated_output, json(result.choices).length),
            estimated: true,
          };
      }
    } catch (error) {
      failure = {
        code: error.code || (controller.signal.aborted ? 'generation_interrupted' : 'worker_unavailable'),
        message:
          error instanceof ApiError
            ? error.message
            : 'Communication avec le worker interrompue ou réponse invalide.',
      };
      uncertain = controller.signal.aborted || !response || response.ok;
      if (!run.cancelled && ![400, 422].includes(response?.status))
        this.db
          .prepare(
            "UPDATE workers SET status = 'unavailable', failures = failures + 1, error = ? WHERE id = ?",
          )
          .run(failure.code, worker.id);
    } finally {
      clearTimeout(timer);
      usage ||= run.usage;
      usage ||= {
        prompt_tokens: response && !response.ok ? 0 : job.estimated_input,
        completion_tokens: uncertain ? job.estimated_output : 0,
        estimated: true,
      };
      this.db
        .transaction(() => {
          this.service.quotas.record(job, attemptId, usage);
          this.db
            .prepare(
              'UPDATE attempts SET status = ?, finished_at = ?, hold_until = ?, error = ? WHERE id = ?',
            )
            .run(
              uncertain ? 'uncertain' : failure ? 'failed' : 'succeeded',
              Date.now(),
              uncertain ? deadline : null,
              failure ? json(failure) : null,
              attemptId,
            );
          const current = this.service.get(job.id);
          if (current.active_attempt_id === attemptId && !terminal(current.status)) {
            if (!failure) this.service.finish(job.id, 'succeeded', result);
            else if (
              (!this.stopping || current.mode === 'async') &&
              !run.cancelled &&
              retryable &&
              !run.exposed &&
              current.attempts < this.config.maxAttempts &&
              current.expires_at > Date.now()
            ) {
              this.db
                .prepare(
                  "UPDATE jobs SET status = 'queued', active_attempt_id = NULL, available_at = ?, error = ? WHERE id = ?",
                )
                .run(Date.now() + 1000 * 2 ** (current.attempts - 1), json(failure), job.id);
              this.service.notify(job.id);
            } else this.service.finish(job.id, run.cancelled ? 'cancelled' : 'failed', null, failure);
          }
        })
        .immediate();
      this.running.delete(job.id);
      this.tick();
    }
  }

  async consumeStream(response, job, run) {
    const decoder = new TextDecoder();
    let buffer = '';
    let usage;
    let doneEvent = false;
    let bytes = 0;
    const chunks = [];
    const reader = response.body.getReader();
    const client = this.clients.get(job.id);
    const forward = async (chunk) => {
      const data = json(chunk);
      chunks.push(chunk);
      run.received = true;
      if (client && !run.cancelled) {
        // Mark before writing: retrying after any attempted exposure could duplicate output.
        run.exposed = true;
        await client.write(`data: ${data}\n\n`);
      }
    };
    const event = async (text) => {
      const data = text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) return;
      if (data === '[DONE]') {
        doneEvent = true;
        return;
      }
      const chunk = JSON.parse(data);
      if (chunk.error) throw new Error('Erreur dans le flux du worker.');
      if (!Array.isArray(chunk.choices)) throw new Error('Fragment SSE invalide.');
      if (this.validUsage(chunk.usage)) {
        usage = { ...chunk.usage, estimated: false };
        run.usage = usage;
      }
      await forward(chunk);
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > this.config.bodyLimit) throw new Error('Flux trop volumineux.');
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const text = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          await event(text);
          if (doneEvent) break;
        }
        if (doneEvent) break;
      }
      if (!doneEvent) throw new Error('Flux interrompu avant [DONE].');
      const choices = new Map();
      for (const chunk of chunks)
        for (const choice of chunk.choices) {
          const current = choices.get(choice.index) || {
            index: choice.index,
            message: { role: 'assistant', content: '' },
            finish_reason: null,
          };
          const delta = choice.delta || {};
          if (delta.content) current.message.content += delta.content;
          if (delta.refusal) current.message.refusal = (current.message.refusal || '') + delta.refusal;
          if (delta.tool_calls) {
            current.message.tool_calls ||= [];
            for (const tool of delta.tool_calls) {
              const prev = (current.message.tool_calls[tool.index] ||= {
                id: '',
                type: 'function',
                function: { name: '', arguments: '' },
              });
              if (tool.id) prev.id += tool.id;
              if (tool.function?.name) prev.function.name += tool.function.name;
              if (tool.function?.arguments) prev.function.arguments += tool.function.arguments;
            }
          }
          if (choice.finish_reason) current.finish_reason = choice.finish_reason;
          choices.set(choice.index, current);
        }
      const finalChoices = [...choices.values()];
      if (!finalChoices.length) throw new Error('Flux terminé sans réponse.');
      usage ||= {
        prompt_tokens: job.estimated_input,
        completion_tokens: Math.min(job.estimated_output, json(finalChoices).length),
        estimated: true,
      };
      const first = chunks[0] || {};
      return {
        result: {
          id: first.id || job.id,
          object: 'chat.completion',
          created: first.created || Math.floor(Date.now() / 1000),
          model: job.model,
          choices: finalChoices,
          usage,
        },
        usage,
      };
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    clearInterval(this.probeTimer);
    for (const run of this.running.values()) run.controller.abort(new Error('service_stopping'));
    while (this.running.size || this.probing.size) await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
