import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, until, mockWorker, addWorker, adminLogin, pause } from './helpers.js';
import { hash, json } from '../src/security.js';
import { chooseJob } from '../src/scheduler.js';

test('API : authentification, isolation, modèles et validation', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.app.inject('/v1/models')).statusCode, 401);
  assert.equal((await f.inject('/v1/models')).json().data.length, 1);
  for (const body of [
    { ...f.request, model: 'unknown' },
    { ...f.request, n: 2 },
    { ...f.request, stream: true },
    { ...f.request, messages: [] },
    { ...f.request, max_tokens: 100000 },
  ])
    assert.equal((await f.inject('/v1/jobs', body)).statusCode, 400);
  const response = await f.inject('/v1/jobs', f.request);
  assert.equal(response.statusCode, 202);
  const id = response.json().id;
  assert.equal((await f.inject(`/v1/jobs/${id}`)).json().status, 'queued');
  assert.equal((await f.inject(`/v1/jobs/${randomUUID()}`)).statusCode, 404);
  f.db
    .prepare('UPDATE api_keys SET restrictions=? WHERE id=?')
    .run(json({ models: ['another'], ips: [], modes: [] }), f.key);
  assert.equal((await f.inject('/v1/jobs', f.request)).statusCode, 403);
});

test('Idempotence atomique : même job, conflit sur payload ou utilisateur', async (t) => {
  const f = await fixture(t);
  const options = { headers: { ...f.headers, 'idempotency-key': 'unique' } };
  const responses = await Promise.all(
    Array.from({ length: 20 }, () => f.inject('/v1/jobs', f.request, options)),
  );
  assert.equal(responses.filter((r) => r.statusCode === 202).length, 1);
  assert.equal(new Set(responses.map((r) => r.json().id)).size, 1);
  assert.equal((await f.inject('/v1/jobs', { ...f.request, temperature: 0 }, options)).statusCode, 409);
  assert.equal(
    (await f.inject('/v1/jobs', f.request, { headers: { ...options.headers, 'x-end-user-id': 'someone' } }))
      .statusCode,
    409,
  );
});

test('Réservations concurrentes, annulation et aucun quota : pas de dépassement à l’admission', async (t) => {
  const f = await fixture(t);
  f.db
    .prepare('UPDATE applications SET policy=? WHERE id=?')
    .run(
      json({ count: 'output', credit: { enabled: true, tokens: 64 }, windows: [{ hours: 6, tokens: 64 }] }),
      f.application,
    );
  const responses = await Promise.all(Array.from({ length: 20 }, () => f.inject('/v1/jobs', f.request)));
  assert.equal(responses.filter((r) => r.statusCode === 202).length, 2);
  assert.equal(responses.filter((r) => r.statusCode === 429).length, 18);
  const job = responses.find((r) => r.statusCode === 202).json();
  await f.inject(`/v1/jobs/${job.id}/cancel`, {});
  assert.equal((await f.inject('/v1/jobs', f.request)).statusCode, 202);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 3);
});

test('Quotas application + clé + utilisateur, défaut et exception, fenêtre glissante', async (t) => {
  const f = await fixture(t);
  const userPolicy = {
    count: 'output',
    credit: { enabled: false, tokens: 0 },
    windows: [{ hours: 1, tokens: 32 }],
  };
  f.db
    .prepare('UPDATE applications SET require_user=1, default_user_policy=? WHERE id=?')
    .run(json(userPolicy), f.application);
  assert.equal((await f.inject('/v1/jobs', f.request)).statusCode, 400);
  const opts = { headers: { ...f.headers, 'x-end-user-id': 'eleve-1' } };
  const first = await f.inject('/v1/jobs', f.request, opts);
  assert.equal(first.statusCode, 202);
  assert.equal((await f.inject('/v1/jobs', f.request, opts)).statusCode, 429);
  assert.equal(
    (await f.inject('/v1/jobs', f.request, { headers: { ...f.headers, 'x-end-user-id': 'eleve-2' } }))
      .statusCode,
    202,
  );
  const user = f.db.prepare('SELECT * FROM end_users WHERE external_id=?').get('eleve-1');
  f.db.prepare('UPDATE end_users SET policy=? WHERE id=?').run('{}', user.id);
  assert.equal((await f.inject('/v1/jobs', f.request, opts)).statusCode, 202);
  f.db
    .prepare('UPDATE api_keys SET policy=? WHERE id=?')
    .run(json({ count: 'input', credit: { enabled: true, tokens: 0 } }), f.key);
  assert.equal((await f.inject('/v1/jobs', f.request, opts)).statusCode, 429);
});

test('Restrictions IP et modes, liste worker sans secrets', async (t) => {
  const f = await fixture(t);
  addWorker(f, { url: 'http://127.0.0.1:1/v1' });
  const status = await f.inject('/v1/workers/status');
  assert.equal(status.statusCode, 200);
  assert.ok(!status.body.includes('http://'));
  f.db
    .prepare('UPDATE api_keys SET restrictions=? WHERE id=?')
    .run(json({ modes: ['stream'], ips: ['127.0.0.1/32'] }), f.key);
  assert.equal((await f.inject('/v1/jobs', f.request)).statusCode, 403);
  f.db.prepare('UPDATE api_keys SET restrictions=? WHERE id=?').run(json({ ips: ['10.0.0.0/8'] }), f.key);
  assert.equal((await f.inject('/v1/models')).statusCode, 403);
});

test('Rafale de 200 jobs : capacités remplies, aucune perte ni double tentative', async (t) => {
  const f = await fixture(t);
  const worker1 = await mockWorker(t, { delay: 15 });
  const worker2 = await mockWorker(t, { delay: 20 });
  addWorker(f, worker1, 2);
  addWorker(f, worker2, 3);
  const responses = await Promise.all(Array.from({ length: 200 }, () => f.inject('/v1/jobs', f.request)));
  assert.ok(responses.every((r) => r.statusCode === 202));
  await until(
    () => f.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='succeeded'").get().n === 200,
    20000,
  );
  assert.equal(worker1.max, 2);
  assert.equal(worker2.max, 3);
  assert.equal(worker1.calls + worker2.calls, 200);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM attempts').get().n, 200);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM reservations').get().n, 0);
  assert.equal(f.db.prepare('SELECT SUM(input_tokens+output_tokens) n FROM usage').get().n, 1400);
});

test('Ordonnancement : ratio interactif, partage entre applications et utilisateurs, FIFO local', () => {
  const state = { streak: 0, apps: {}, users: {} };
  const jobs = [];
  for (let i = 0; i < 20; i++)
    for (const mode of ['chat', 'async'])
      for (const app of ['a', 'b'])
        for (const user of ['u', 'v'])
          jobs.push({ id: `${mode}-${app}-${user}-${i}`, mode, app_id: app, user_id: user });
  const selected = [];
  for (let i = 0; i < 16; i++) {
    const j = chooseJob(jobs, state);
    selected.push(j);
    jobs.splice(jobs.indexOf(j), 1);
  }
  assert.deepEqual(
    selected.slice(0, 4).map((j) => j.mode),
    ['chat', 'chat', 'chat', 'async'],
  );
  assert.equal(selected.filter((j) => j.mode === 'async').length, 4);
  assert.deepEqual(new Set(selected.map((j) => j.app_id)), new Set(['a', 'b']));
  assert.deepEqual(new Set(selected.map((j) => j.user_id)), new Set(['u', 'v']));
  for (const group of ['chat-a-u', 'chat-a-v', 'chat-b-u', 'chat-b-v'])
    assert.ok(selected.find((j) => j.id.startsWith(group)).id.endsWith('-0'));
});

test('Routage : un modèle indisponible ne bloque pas les autres', async (t) => {
  const f = await fixture(t);
  f.db.prepare('INSERT INTO models VALUES (?,?,?,?,?,?)').run('other', 32768, 128, 1, 1024, 0);
  const blocked = (await f.inject('/v1/jobs', { ...f.request, model: 'other' })).json();
  const worker = await mockWorker(t);
  addWorker(f, worker);
  const runnable = (await f.inject('/v1/jobs', f.request)).json();
  await until(() => f.service.get(runnable.id).status === 'succeeded');
  assert.equal(f.service.get(blocked.id).status, 'queued');
  assert.equal(f.service.publicJob(f.service.get(blocked.id)).queue.reason, 'workers_unavailable');
});

test('Streaming réel : en-tête immédiat, tokens standards et consommation finale', async (t) => {
  const f = await fixture(t);
  const worker = await mockWorker(t, { delay: 40 });
  addWorker(f, worker);
  await f.app.listen({ port: 0, host: '127.0.0.1' });
  const response = await fetch(`${f.app.listeningOrigin}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...f.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...f.request, stream: true }),
  });
  const id = response.headers.get('x-job-id');
  assert.ok(id);
  const text = await response.text();
  assert.ok(text.includes(': queued'));
  assert.ok(text.includes('"content":"Bon"'));
  assert.ok(text.includes('"content":"jour"'));
  assert.equal(text.match(/data: \[DONE\]/g).length, 1);
  assert.equal(f.service.get(id).status, 'succeeded');
  assert.equal(f.service.publicJob(f.service.get(id)).usage.total_tokens, 7);
  assert.equal(worker.requests[0].stream_options.include_usage, true);
  assert.equal(JSON.parse(f.service.get(id).result).choices[0].message.content, 'Bonjour');
});

test('Chat synchrone utilise la file et renvoie la réponse OpenAI', async (t) => {
  const f = await fixture(t);
  const worker = await mockWorker(t);
  addWorker(f, worker);
  const response = await f.inject('/v1/chat/completions', f.request);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().choices[0].message.content, 'Bonjour');
  assert.ok(response.headers['x-job-id']);
});

test('Déconnexion avant attribution : job annulé et réservations libérées', async (t) => {
  const f = await fixture(t);
  await f.app.listen({ port: 0, host: '127.0.0.1' });
  const response = await fetch(`${f.app.listeningOrigin}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...f.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...f.request, stream: true }),
  });
  const id = response.headers.get('x-job-id');
  await response.body.cancel();
  await until(() => f.service.get(id).status === 'cancelled');
  assert.equal(f.service.get(id).attempts, 0);
});

test('Interruption après un fragment : aucun rejeu et capacité incertaine', async (t) => {
  const f = await fixture(t);
  const worker = await mockWorker(t, { breakStream: true });
  const id = addWorker(f, worker);
  const response = await f.inject('/v1/chat/completions', { ...f.request, stream: true });
  assert.equal(worker.calls, 1);
  assert.ok(response.body.includes('"content":"Bon"'));
  assert.ok(response.body.includes('"error"'));
  const job = f.service.get(response.headers['x-job-id']);
  assert.equal(job.status, 'failed');
  assert.equal(f.scheduler.occupied(id), 1);
});

test('Expiration et nettoyage des contenus conservent le registre de consommation', async (t) => {
  const f = await fixture(t);
  const job = f.service.submit(f.auth(), f.request, 'async').job;
  f.db.prepare('UPDATE jobs SET expires_at=? WHERE id=?').run(Date.now() - 1, job.id);
  f.scheduler.tick();
  assert.equal(f.service.get(job.id).status, 'expired');
  f.db.prepare('UPDATE jobs SET finished_at=? WHERE id=?').run(Date.now() - 8 * 86400000, job.id);
  f.service.cleanup();
  const cleaned = f.service.get(job.id);
  assert.equal(cleaned.request, null);
  assert.ok(cleaned.purged_at);
});

test('Administration : cookie, CSRF, création, secrets masqués et utilisateur par défaut', async (t) => {
  const f = await fixture(t);
  const headers = await adminLogin(f);
  const payload = {
    name: 'Moodle',
    require_user: true,
    callback_bases: ['http://moodle.local/hooks'],
    policy: {},
    default_user_policy: {},
  };
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: '/admin/api/applications',
        headers: { cookie: headers.cookie },
        payload,
      })
    ).statusCode,
    403,
  );
  const created = await f.app.inject({ method: 'POST', url: '/admin/api/applications', headers, payload });
  assert.equal(created.statusCode, 200);
  assert.ok(created.json().callback_secret);
  const key = await f.app.inject({
    method: 'POST',
    url: `/admin/api/applications/${created.json().id}/keys`,
    headers,
    payload: { name: 'Moodle key' },
  });
  assert.ok(key.json().api_key);
  const snapshot = await f.app.inject({ url: '/admin/api/snapshot', headers });
  assert.ok(!snapshot.body.includes(key.json().api_key));
  assert.ok(!snapshot.body.includes(created.json().callback_secret));
  assert.equal((await f.app.inject({ url: '/admin/api/me' })).statusCode, 401);
});

test('Isolation entre applications et révocation de clé', async (t) => {
  const f = await fixture(t);
  const job = (await f.inject('/v1/jobs', f.request)).json();
  const other = randomUUID(),
    key = randomUUID();
  f.db
    .prepare('INSERT INTO applications(id,name,require_user,created_at) VALUES (?,?,?,?)')
    .run(other, 'Other', 0, Date.now());
  f.db
    .prepare('INSERT INTO api_keys(id,app_id,name,prefix,digest,created_at) VALUES (?,?,?,?,?,?)')
    .run(key, other, 'Other', 'other', hash('other'), Date.now());
  assert.equal(
    (await f.inject(`/v1/jobs/${job.id}`, undefined, { headers: { authorization: 'Bearer other' } }))
      .statusCode,
    404,
  );
  f.db.prepare('UPDATE api_keys SET enabled=0 WHERE id=?').run(f.key);
  assert.equal((await f.inject('/v1/models')).statusCode, 401);
});
