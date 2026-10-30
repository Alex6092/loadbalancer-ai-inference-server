import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const migrations = [
  `CREATE TABLE applications (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    require_user INTEGER NOT NULL DEFAULT 1, policy TEXT NOT NULL DEFAULT '{}',
    default_user_policy TEXT NOT NULL DEFAULT '{}', callback_bases TEXT NOT NULL DEFAULT '[]',
    callback_secret TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES applications(id), name TEXT NOT NULL,
    prefix TEXT NOT NULL, digest TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1,
    restrictions TEXT NOT NULL DEFAULT '{}', policy TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
  );
  CREATE TABLE end_users (
    id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES applications(id), external_id TEXT NOT NULL,
    policy TEXT, created_at INTEGER NOT NULL, UNIQUE(app_id, external_id)
  );
  CREATE TABLE models (
    id TEXT PRIMARY KEY, context_tokens INTEGER NOT NULL, max_output_tokens INTEGER NOT NULL,
    input_tokens_per_char REAL NOT NULL DEFAULT 1, image_tokens INTEGER NOT NULL DEFAULT 8192,
    vision INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE workers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, secret TEXT, models TEXT NOT NULL,
    concurrency INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'checking', failures INTEGER NOT NULL DEFAULT 0,
    last_check INTEGER, last_success INTEGER, error TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE jobs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    app_id TEXT NOT NULL REFERENCES applications(id), key_id TEXT NOT NULL REFERENCES api_keys(id),
    user_id TEXT REFERENCES end_users(id), mode TEXT NOT NULL, model TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', request TEXT, result TEXT, error TEXT,
    estimated_input INTEGER NOT NULL, estimated_output INTEGER NOT NULL,
    callback_url TEXT, idempotency_key TEXT, request_hash TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, active_attempt_id TEXT,
    created_at INTEGER NOT NULL, available_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    started_at INTEGER, finished_at INTEGER, purged_at INTEGER,
    UNIQUE(key_id, idempotency_key)
  );
  CREATE INDEX jobs_queue ON jobs(status, available_at, seq);
  CREATE INDEX jobs_app ON jobs(app_id, created_at);
  CREATE INDEX jobs_user ON jobs(user_id, created_at);
  CREATE TABLE attempts (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), worker_id TEXT NOT NULL REFERENCES workers(id),
    status TEXT NOT NULL, started_at INTEGER NOT NULL, deadline INTEGER NOT NULL, finished_at INTEGER,
    hold_until INTEGER, error TEXT
  );
  CREATE INDEX attempts_worker ON attempts(worker_id, status, hold_until);
  CREATE TABLE usage (
    attempt_id TEXT PRIMARY KEY REFERENCES attempts(id), job_id TEXT NOT NULL REFERENCES jobs(id),
    app_id TEXT NOT NULL, key_id TEXT NOT NULL, user_id TEXT, model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, estimated INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX usage_app ON usage(app_id, created_at);
  CREATE INDEX usage_key ON usage(key_id, created_at);
  CREATE INDEX usage_user ON usage(user_id, created_at);
  CREATE TABLE reservations (
    job_id TEXT NOT NULL REFERENCES jobs(id), scope TEXT NOT NULL, scope_id TEXT NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, PRIMARY KEY(job_id, scope, scope_id)
  );
  CREATE INDEX reservations_scope ON reservations(scope, scope_id);
  CREATE TABLE credits (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_id TEXT NOT NULL, tokens INTEGER NOT NULL,
    note TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE callbacks (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id), status TEXT NOT NULL,
    payload TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, last_status INTEGER, last_error TEXT, delivered_at INTEGER
  );
  CREATE INDEX callbacks_pending ON callbacks(status, next_at);
  CREATE TABLE admins (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE sessions (digest TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES admins(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE audit (id INTEGER PRIMARY KEY, admin_id TEXT, action TEXT NOT NULL, target TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE scheduler_state (name TEXT PRIMARY KEY, value TEXT NOT NULL);`,
];

export function openDatabase(filename) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const version = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM migrations').get().version;
  if (version > migrations.length) throw new Error('La base est plus récente que cette version du service.');
  for (let i = version; i < migrations.length; i++)
    db.transaction(() => {
      db.exec(migrations[i]);
      db.prepare('INSERT INTO migrations VALUES (?, ?)').run(i + 1, Date.now());
    }).immediate();
  if (filename !== ':memory:') {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.chmodSync(filename + suffix, 0o600);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return db;
}
