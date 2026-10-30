import { ApiError, parse } from './security.js';

export function normalizePolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(400, 'invalid_policy', 'Politique de quota invalide.');
  const count = value.count || 'both';
  if (!['input', 'output', 'both'].includes(count))
    throw new ApiError(400, 'invalid_policy', 'Comptage invalide.');
  if (value.credit != null && (typeof value.credit !== 'object' || Array.isArray(value.credit)))
    throw new ApiError(400, 'invalid_policy', 'Crédit invalide.');
  if (value.credit?.enabled != null && typeof value.credit.enabled !== 'boolean')
    throw new ApiError(400, 'invalid_policy', 'Activation du crédit invalide.');
  const credit = { enabled: value.credit?.enabled ?? false, tokens: value.credit?.tokens ?? 0 };
  if (!Number.isSafeInteger(credit.tokens) || credit.tokens < 0)
    throw new ApiError(400, 'invalid_policy', 'Crédit invalide.');
  if (value.windows != null && (!Array.isArray(value.windows) || value.windows.length > 20))
    throw new ApiError(400, 'invalid_policy', 'Fenêtres invalides (20 maximum).');
  const windows = (value.windows || []).map((w) => {
    if (
      !w ||
      !Number.isFinite(w.hours) ||
      w.hours <= 0 ||
      w.hours > 87600 ||
      (w.enabled != null && typeof w.enabled !== 'boolean') ||
      !Number.isSafeInteger(w.tokens) ||
      w.tokens < 0
    )
      throw new ApiError(400, 'invalid_policy', 'Fenêtre de quota invalide.');
    return { hours: w.hours, tokens: w.tokens, enabled: w.enabled !== false };
  });
  return { count, credit, windows };
}

const columns = { application: 'app_id', key: 'key_id', user: 'user_id' };
export const counted = (input, output, count) =>
  count === 'input' ? input : count === 'output' ? output : input + output;

export class Quotas {
  constructor(db) {
    this.db = db;
  }

  scopes(job) {
    const app = this.db.prepare('SELECT * FROM applications WHERE id = ?').get(job.app_id);
    const key = this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(job.key_id);
    const result = [
      { scope: 'application', id: app.id, policy: parse(app.policy, {}) },
      { scope: 'key', id: key.id, policy: parse(key.policy, {}) },
    ];
    if (job.user_id) {
      const user = this.db.prepare('SELECT * FROM end_users WHERE id = ?').get(job.user_id);
      result.push({ scope: 'user', id: user.id, policy: parse(user.policy ?? app.default_user_policy, {}) });
    }
    return result.map((s) => ({ ...s, policy: normalizePolicy(s.policy) }));
  }

  report(scope, id, policy, now = Date.now(), excludeJob = '') {
    policy = normalizePolicy(policy);
    const column = columns[scope];
    if (!column) throw new ApiError(400, 'invalid_scope', 'Périmètre invalide.');
    const usageSince = (since) => {
      const row = this.db
        .prepare(
          `SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output FROM usage WHERE ${column} = ? AND created_at >= ?`,
        )
        .get(id, since);
      return counted(row.input, row.output, policy.count);
    };
    const reserved = this.db
      .prepare(
        'SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output FROM reservations WHERE scope = ? AND scope_id = ? AND job_id != ?',
      )
      .get(scope, id, excludeJob);
    const reservedTokens = counted(reserved.input, reserved.output, policy.count);
    const recharge = this.db
      .prepare('SELECT COALESCE(SUM(tokens),0) AS tokens FROM credits WHERE scope = ? AND scope_id = ?')
      .get(scope, id).tokens;
    const credit = policy.credit.enabled
      ? { limit: policy.credit.tokens + recharge, used: usageSince(0), reserved: reservedTokens }
      : null;
    if (credit) credit.available = credit.limit - credit.used - credit.reserved;
    const windows = policy.windows
      .filter((w) => w.enabled)
      .map((w) => {
        const used = usageSince(now - w.hours * 3600000);
        return {
          hours: w.hours,
          limit: w.tokens,
          used,
          reserved: reservedTokens,
          available: w.tokens - used - reservedTokens,
        };
      });
    return { scope, id, count: policy.count, credit, windows };
  }

  reserve(job, now = Date.now()) {
    // Caller holds the same SQLite write transaction as job acceptance/assignment.
    const insert = this.db.prepare('INSERT OR REPLACE INTO reservations VALUES (?, ?, ?, ?, ?)');
    for (const s of this.scopes(job)) {
      const report = this.report(s.scope, s.id, s.policy, now, job.id);
      const requested = counted(job.estimated_input, job.estimated_output, report.count);
      const failed = [report.credit, ...report.windows].find((rule) => rule && rule.available < requested);
      let retryAt = null;
      if (failed?.hours && requested <= failed.limit - failed.reserved) {
        const events = this.db
          .prepare(
            `SELECT input_tokens, output_tokens, created_at FROM usage WHERE ${columns[s.scope]} = ? AND created_at >= ? ORDER BY created_at`,
          )
          .all(s.id, now - failed.hours * 3600000);
        let released = 0;
        for (const event of events) {
          released += counted(event.input_tokens, event.output_tokens, report.count);
          if (released >= requested - failed.available) {
            retryAt = new Date(event.created_at + failed.hours * 3600000 + 1).toISOString();
            break;
          }
        }
      }
      if (failed)
        throw new ApiError(429, 'quota_exceeded', 'Budget de tokens insuffisant.', {
          scope: s.scope,
          scope_id: s.id,
          requested,
          available: failed.available,
          window_hours: failed.hours ?? null,
          retry_at: retryAt,
          reason:
            'Les réservations et la consommation réelle peuvent évoluer ; consulter de nouveau les quotas.',
        });
      if (report.credit || report.windows.length)
        insert.run(job.id, s.scope, s.id, job.estimated_input, job.estimated_output);
      else
        this.db
          .prepare('DELETE FROM reservations WHERE job_id = ? AND scope = ? AND scope_id = ?')
          .run(job.id, s.scope, s.id);
    }
  }

  release(jobId) {
    this.db.prepare('DELETE FROM reservations WHERE job_id = ?').run(jobId);
  }

  record(job, attemptId, usage, now = Date.now()) {
    this.db
      .prepare('INSERT OR IGNORE INTO usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        attemptId,
        job.id,
        job.app_id,
        job.key_id,
        job.user_id,
        job.model,
        usage.prompt_tokens,
        usage.completion_tokens,
        usage.estimated ? 1 : 0,
        now,
      );
    // Keep the content-free accounting ledger for lifetime credits and long rolling windows.
  }

  reports(job) {
    return this.scopes(job).map((s) => this.report(s.scope, s.id, s.policy));
  }
}
