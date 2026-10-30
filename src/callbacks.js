import { decrypt, signature, callbackAllowed, parse } from './security.js';

export class Callbacks {
  constructor(service, logger) {
    this.service = service;
    this.db = service.db;
    this.config = service.config;
    this.log = logger;
    this.active = new Map();
    this.stopping = false;
  }

  start() {
    this.timer = setInterval(() => this.tick(), 500);
    this.timer.unref();
    this.tick();
  }

  tick() {
    if (this.stopping) return;
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE callbacks SET status = 'failed', last_error = 'Délai de livraison dépassé' WHERE status = 'pending' AND expires_at <= ?",
      )
      .run(now);
    const slots = 5 - this.active.size;
    if (slots <= 0) return;
    const ready = this.db
      .prepare(
        "SELECT c.*, j.callback_url, j.app_id FROM callbacks c JOIN jobs j ON j.id = c.job_id WHERE c.status = 'pending' AND c.next_at <= ? AND c.expires_at > ? ORDER BY c.next_at LIMIT 10",
      )
      .all(now, now);
    let launched = 0;
    for (const callback of ready) {
      if (launched >= slots) break;
      if (!this.active.has(callback.id)) {
        launched++;
        const controller = new AbortController();
        const promise = this.send(callback, controller)
          .catch((error) => this.log.error({ message: error.message }, 'Erreur interne de callback'))
          .finally(() => this.active.delete(callback.id));
        this.active.set(callback.id, { promise, controller });
      }
    }
  }

  async send(callback, controller) {
    let status = null;
    let error = null;
    const timer = setTimeout(() => controller.abort(), this.config.callbackTimeoutMs);
    timer.unref();
    try {
      const app = this.db.prepare('SELECT * FROM applications WHERE id = ?').get(callback.app_id);
      if (
        !callback.payload ||
        !callback.callback_url ||
        !app.callback_secret ||
        !callbackAllowed(callback.callback_url, parse(app.callback_bases))
      ) {
        throw new Error('Destination supprimée ou secret indisponible.');
      }
      const secret = decrypt(app.callback_secret, this.config.encryptionKey);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const response = await fetch(callback.callback_url, {
        method: 'POST',
        body: callback.payload,
        signal: controller.signal,
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          'X-Event-ID': callback.id,
          'X-Callback-Timestamp': timestamp,
          'X-Callback-Signature': `sha256=${signature(secret, timestamp, callback.payload)}`,
        },
      });
      status = response.status;
      await response.body?.cancel();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch {
      error = status ? `HTTP ${status}` : 'Livraison impossible (réseau, délai ou configuration).';
    } finally {
      clearTimeout(timer);
    }
    const now = Date.now();
    if (!error)
      this.db
        .prepare(
          "UPDATE callbacks SET status = 'delivered', attempts = attempts + 1, last_status = ?, last_error = NULL, delivered_at = ? WHERE id = ?",
        )
        .run(status, now, callback.id);
    else {
      const next = now + Math.min(3600000, 1000 * 2 ** Math.min(callback.attempts, 12));
      this.db
        .prepare(
          'UPDATE callbacks SET attempts = attempts + 1, status = ?, next_at = ?, last_status = ?, last_error = ? WHERE id = ?',
        )
        .run(now >= callback.expires_at ? 'failed' : 'pending', next, status, error, callback.id);
    }
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    for (const entry of this.active.values()) entry.controller.abort();
    await Promise.all([...this.active.values()].map((entry) => entry.promise));
  }
}
