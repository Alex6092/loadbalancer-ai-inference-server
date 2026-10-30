import { randomUUID, randomBytes } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { encrypt, hash, json, passwordHash } from '../src/security.js';

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(condition, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await condition();
    if (result) return result;
    await pause(10);
  }
  throw new Error('Condition non satisfaite dans le délai prévu.');
}

export async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'providence-'));
  const app = await createServer({
    database: path.join(directory, 'test.sqlite'),
    encryptionKey: randomBytes(32).toString('base64'),
    secureCookies: false,
    logger: false,
    background: false,
    tickMs: 10,
    probeIntervalMs: 50,
    probeTimeoutMs: 300,
    callbackTimeoutMs: 300,
    ...options,
  });
  await app.ready();
  const { db, config, service, scheduler, callbacks } = app.context;
  const application = randomUUID(),
    key = randomUUID(),
    secret = 'test-key';
  db.prepare(
    'INSERT INTO applications(id,name,require_user,callback_secret,created_at) VALUES (?,?,?,?,?)',
  ).run(application, 'Test application', 0, encrypt('callback-secret', config.encryptionKey), Date.now());
  db.prepare('INSERT INTO api_keys(id,app_id,name,prefix,digest,created_at) VALUES (?,?,?,?,?,?)').run(
    key,
    application,
    'Test key',
    'test',
    hash(secret),
    Date.now(),
  );
  db.prepare('INSERT INTO models VALUES (?, ?, ?, ?, ?, ?)').run('test-model', 32768, 128, 1, 1024, 1);
  const auth = () => ({
    app: db.prepare('SELECT * FROM applications WHERE id=?').get(application),
    key: db.prepare('SELECT * FROM api_keys WHERE id=?').get(key),
  });
  const headers = { authorization: `Bearer ${secret}` };
  const request = { model: 'test-model', messages: [{ role: 'user', content: 'Bonjour' }], max_tokens: 32 };
  const inject = (url, body, extra = {}) =>
    app.inject({
      url,
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { payload: body }),
      ...extra,
    });
  t.after(async () => {
    await app.close();
    if (
      path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
      !path.basename(directory).startsWith('providence-')
    )
      throw new Error('Répertoire de test inattendu.');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    app,
    db,
    config,
    service,
    scheduler,
    callbacks,
    application,
    key,
    secret,
    headers,
    auth,
    request,
    inject,
    directory,
  };
}

export async function adminLogin(f) {
  const id = randomUUID();
  f.db
    .prepare('INSERT INTO admins VALUES (?,?,?,?)')
    .run(id, 'admin', await passwordHash('correct-password-123'), Date.now());
  const login = await f.app.inject({
    method: 'POST',
    url: '/admin/api/login',
    payload: { username: 'admin', password: 'correct-password-123' },
  });
  const cookie = login.headers['set-cookie'].split(';')[0];
  return { cookie, 'x-csrf-token': login.json().csrf };
}

export async function mockWorker(t, behavior = {}) {
  const state = { active: 0, max: 0, calls: 0, requests: [], health: true, behavior };
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(state.health ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: (behavior.models || ['test-model']).map((id) => ({ id })) }));
      return;
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    state.calls++;
    state.requests.push(body);
    state.active++;
    state.max = Math.max(state.max, state.active);
    let closed = false;
    res.on('close', () => {
      if (!closed) {
        closed = true;
        state.active--;
      }
    });
    if (behavior.failCount && state.calls <= behavior.failCount) {
      res.writeHead(503);
      res.end();
      return;
    }
    if (behavior.status) {
      res.writeHead(behavior.status);
      res.end();
      return;
    }
    if (behavior.hang) return;
    await pause(behavior.delay ?? 20);
    if (res.destroyed) return;
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const word of ['Bon', 'jour']) {
        if (res.destroyed) return;
        res.write(
          `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: word }, finish_reason: null }] })}\n\n`,
        );
        await pause(behavior.tokenDelay ?? 5);
        if (behavior.breakStream) {
          res.destroy();
          return;
        }
      }
      res.write(
        `data: ${JSON.stringify({ id: 'chatcmpl-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
      );
      if (!behavior.noUsage)
        res.write(
          `data: ${JSON.stringify({ id: 'chatcmpl-test', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`,
        );
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Bonjour' }, finish_reason: 'stop' }],
          ...(behavior.noUsage ? {} : { usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
        }),
      );
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  state.url = `http://127.0.0.1:${server.address().port}/v1`;
  return state;
}

export function addWorker(f, worker, concurrency = 1, models = ['test-model']) {
  const id = randomUUID();
  f.db
    .prepare(
      "INSERT INTO workers(id,name,url,models,concurrency,status,created_at) VALUES (?,?,?,?,?,'available',?)",
    )
    .run(id, 'Worker', worker.url, json(models), concurrency, Date.now());
  return id;
}
