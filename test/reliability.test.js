import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fixture, mockWorker, addWorker, until, adminLogin, pause } from './helpers.js';
import { signature, json } from '../src/security.js';
import { createServer } from '../src/server.js';
import { openDatabase } from '../src/db.js';

test('Callbacks : signature vérifiable, identifiant stable et réessai sans nouvelle génération', async (t) => {
  const f = await fixture(t);
  const worker = await mockWorker(t);
  addWorker(f, worker);
  const received = [];
  const receiver = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ body, headers: req.headers });
    res.writeHead(received.length === 1 ? 503 : 204);
    res.end();
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    receiver.closeAllConnections();
    await new Promise((resolve) => receiver.close(resolve));
  });
  const base = `http://127.0.0.1:${receiver.address().port}/hooks`;
  f.db.prepare('UPDATE applications SET callback_bases=? WHERE id=?').run(json([base]), f.application);
  assert.equal(
    (await f.inject('/v1/jobs', { ...f.request, callbackURL: base.replace('/hooks', '/other') })).statusCode,
    400,
  );
  const submitted = (await f.inject('/v1/jobs', { ...f.request, callbackURL: `${base}/result` })).json();
  await until(() => f.service.get(submitted.id).status === 'succeeded');
  f.callbacks.tick();
  await until(() => received.length === 1 && f.callbacks.active.size === 0);
  const first = f.db.prepare('SELECT * FROM callbacks WHERE job_id=?').get(submitted.id);
  assert.equal(first.status, 'pending');
  f.db.prepare('UPDATE callbacks SET next_at=? WHERE id=?').run(Date.now() - 1, first.id);
  f.callbacks.tick();
  await until(
    () => f.db.prepare('SELECT status FROM callbacks WHERE id=?').get(first.id).status === 'delivered',
  );
  assert.equal(received.length, 2);
  assert.equal(received[0].body, received[1].body);
  assert.equal(worker.calls, 1);
  for (const r of received) {
    assert.equal(r.headers['x-event-id'], first.id);
    assert.equal(
      r.headers['x-callback-signature'],
      `sha256=${signature('callback-secret', r.headers['x-callback-timestamp'], r.body)}`,
    );
    assert.equal(JSON.parse(r.body).job_id, submitted.id);
  }
});

test('Callbacks : redirection interdite, expiration, relance et purge', async (t) => {
  const f = await fixture(t);
  const headers = await adminLogin(f);
  const receiver = http.createServer((req, res) => {
    res.writeHead(302, { Location: '/forbidden' });
    res.end();
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    receiver.closeAllConnections();
    await new Promise((resolve) => receiver.close(resolve));
  });
  const base = `http://127.0.0.1:${receiver.address().port}`;
  f.db.prepare('UPDATE applications SET callback_bases=? WHERE id=?').run(json([base]), f.application);
  const job = f.service.submit(f.auth(), { ...f.request, callbackURL: `${base}/callback` }, 'async').job;
  f.service.finish(job.id, 'failed', null, { code: 'test', message: 'Test' });
  f.callbacks.tick();
  await until(() => f.callbacks.active.size === 0);
  let callback = f.db.prepare('SELECT * FROM callbacks WHERE job_id=?').get(job.id);
  assert.equal(callback.status, 'pending');
  f.db.prepare('UPDATE callbacks SET expires_at=? WHERE id=?').run(Date.now() - 1, callback.id);
  f.callbacks.tick();
  assert.equal(f.db.prepare('SELECT status FROM callbacks WHERE id=?').get(callback.id).status, 'failed');
  const retry = await f.app.inject({
    method: 'POST',
    url: `/admin/api/callbacks/${callback.id}/retry`,
    headers,
    payload: {},
  });
  assert.equal(retry.statusCode, 200);
  f.db.prepare("UPDATE callbacks SET status='failed' WHERE id=?").run(callback.id);
  f.db.prepare('UPDATE jobs SET finished_at=? WHERE id=?').run(Date.now() - 8 * 86400000, job.id);
  f.service.cleanup();
  assert.equal(f.db.prepare('SELECT payload FROM callbacks WHERE id=?').get(callback.id).payload, null);
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: `/admin/api/callbacks/${callback.id}/retry`,
        headers,
        payload: {},
      })
    ).statusCode,
    410,
  );
});

test('Basculement après erreur HTTP, retour worker et aucune facturation de requête rejetée', async (t) => {
  const f = await fixture(t);
  const bad = await mockWorker(t, { status: 503 });
  const good = await mockWorker(t);
  const badId = addWorker(f, bad);
  f.db.prepare('UPDATE workers SET id=? WHERE id=?').run('000-bad', badId);
  addWorker(f, good);
  const job = (await f.inject('/v1/jobs', f.request)).json();
  await until(() => f.service.get(job.id).status === 'queued' && f.service.get(job.id).attempts === 1);
  assert.equal(f.db.prepare('SELECT input_tokens FROM usage WHERE job_id=?').get(job.id).input_tokens, 0);
  f.db.prepare('UPDATE jobs SET available_at=? WHERE id=?').run(Date.now() - 1, job.id);
  f.scheduler.tick();
  await until(() => f.service.get(job.id).status === 'succeeded');
  assert.equal(good.calls, 1);
  assert.equal(bad.calls, 1);
  bad.health = false;
  await f.scheduler.probe(f.db.prepare('SELECT * FROM workers WHERE id=?').get('000-bad'));
  assert.equal(f.db.prepare('SELECT status FROM workers WHERE id=?').get('000-bad').status, 'unavailable');
  bad.health = true;
  await f.scheduler.probe(f.db.prepare('SELECT * FROM workers WHERE id=?').get('000-bad'));
  assert.equal(f.db.prepare('SELECT status FROM workers WHERE id=?').get('000-bad').status, 'available');
});

test('Erreur de requête non réessayable et quota régularisé sur tokens réels', async (t) => {
  const f = await fixture(t);
  const worker = await mockWorker(t, { status: 400 });
  addWorker(f, worker);
  f.db
    .prepare('UPDATE applications SET policy=? WHERE id=?')
    .run(json({ count: 'both', credit: { enabled: true, tokens: 1000 } }), f.application);
  const job = (await f.inject('/v1/jobs', f.request)).json();
  await until(() => f.service.get(job.id).status === 'failed');
  assert.equal(f.service.get(job.id).attempts, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM reservations').get().n, 0);
  assert.equal(f.service.publicJob(f.service.get(job.id)).usage.total_tokens, 0);
  assert.equal(f.db.prepare('SELECT status FROM workers').get().status, 'available');
});

test('Erreurs transitoires répétées : trois tentatives au maximum', async (t) => {
  const f = await fixture(t);
  const worker = await mockWorker(t, { status: 503 });
  const workerId = addWorker(f, worker);
  const job = (await f.inject('/v1/jobs', f.request)).json();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await until(
      () => f.service.get(job.id).attempts === attempt && f.service.get(job.id).status !== 'running',
    );
    if (attempt < 3) {
      f.db.prepare("UPDATE workers SET status='available' WHERE id=?").run(workerId);
      f.db.prepare('UPDATE jobs SET available_at=? WHERE id=?').run(Date.now() - 1, job.id);
      f.scheduler.tick();
    }
  }
  assert.equal(f.service.get(job.id).status, 'failed');
  assert.equal(worker.calls, 3);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM reservations').get().n, 0);
});

test('Arrêt propre : un traitement asynchrone interrompu est conservé pour reprise', async (t) => {
  const f = await fixture(t);
  const worker = await mockWorker(t, { hang: true });
  addWorker(f, worker);
  const job = (await f.inject('/v1/jobs', f.request)).json();
  await until(() => worker.calls === 1);
  await f.scheduler.stop();
  assert.equal(f.service.get(job.id).status, 'queued');
  assert.equal(f.db.prepare('SELECT status FROM attempts WHERE job_id=?').get(job.id).status, 'uncertain');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM usage WHERE job_id=?').get(job.id).n, 1);
});

test('Arrêt d’un calcul : consommation estimée, tentative incertaine et libération explicite', async (t) => {
  const f = await fixture(t, { attemptTimeoutMs: 200 });
  const worker = await mockWorker(t, { hang: true });
  const id = addWorker(f, worker);
  const job = (await f.inject('/v1/jobs', f.request)).json();
  await until(() => worker.calls === 1);
  await f.inject(`/v1/jobs/${job.id}/cancel`, {});
  await until(() => f.scheduler.running.size === 0);
  assert.equal(f.service.get(job.id).status, 'cancelled');
  assert.equal(f.scheduler.occupied(id), 1);
  assert.equal(f.service.publicJob(f.service.get(job.id)).usage.estimated, true);
  const headers = await adminLogin(f);
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: `/admin/api/workers/${id}/release-uncertain`,
        headers,
        payload: {},
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: `/admin/api/workers/${id}/release-uncertain`,
        headers,
        payload: { confirmed_remote_stopped: true },
      })
    ).statusCode,
    200,
  );
  assert.equal(f.scheduler.occupied(id), 0);
});

async function disconnectMidStream(t, stopsOnDisconnect) {
  const f = await fixture(t);
  const worker = await mockWorker(t, { tokenDelay: 2000 });
  const id = addWorker(f, worker);
  f.db.prepare('UPDATE workers SET stops_on_disconnect=? WHERE id=?').run(stopsOnDisconnect ? 1 : 0, id);
  await f.app.listen({ port: 0, host: '127.0.0.1' });
  // A raw socket makes the disconnection explicit, as when a browser tab is closed.
  const job = await new Promise((resolve, reject) => {
    const request = http.request(`${f.app.listeningOrigin}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...f.headers, 'Content-Type': 'application/json' },
    });
    request.on('error', () => {});
    request.on('response', (response) => {
      let text = '';
      response.on('data', (chunk) => {
        text += chunk;
        if (text.includes('"content":"Bon"')) {
          request.destroy();
          resolve(response.headers['x-job-id']);
        }
      });
      response.on('end', () => reject(new Error('Flux terminé avant la déconnexion.')));
    });
    request.end(JSON.stringify({ ...f.request, stream: true }));
  });
  await until(() => f.scheduler.running.size === 0 && worker.active === 0);
  return { f, worker, id, job };
}

test('Déconnexion du client pendant le streaming : place libérée si le worker s’arrête à la fermeture', async (t) => {
  const { f, worker, id, job } = await disconnectMidStream(t, true);
  assert.equal(f.service.get(job).status, 'cancelled');
  assert.equal(f.db.prepare('SELECT status FROM attempts WHERE job_id=?').get(job).status, 'cancelled');
  assert.equal(f.scheduler.occupied(id), 0);
  const row = f.db.prepare('SELECT * FROM workers WHERE id=?').get(id);
  assert.equal(row.status, 'available');
  assert.ok(f.scheduler.usable(row, Date.now() + 86400000));
  const usage = f.service.publicJob(f.service.get(job)).usage;
  assert.equal(usage.estimated, true);
  assert.equal(usage.completion_tokens, 'Bon'.length);
  const next = (await f.inject('/v1/jobs', f.request)).json();
  await until(() => f.service.get(next.id).status === 'succeeded');
  assert.equal(worker.calls, 2);
});

test('Déconnexion du client pendant le streaming : tentative incertaine sans arrêt fiable déclaré', async (t) => {
  const { f, id, job } = await disconnectMidStream(t, false);
  assert.equal(f.service.get(job).status, 'cancelled');
  assert.equal(f.db.prepare('SELECT status FROM attempts WHERE job_id=?').get(job).status, 'uncertain');
  assert.equal(f.scheduler.occupied(id), 1);
});

test('Annulation explicite d’un job asynchrone en cours : place libérée avec arrêt fiable', async (t) => {
  const f = await fixture(t);
  const worker = await mockWorker(t, { hang: true });
  const id = addWorker(f, worker);
  const headers = await adminLogin(f);
  const settings = { name: 'Worker', url: worker.url, models: ['test-model'], concurrency: 1, enabled: true };
  const update = (payload) =>
    f.app.inject({ method: 'PUT', url: `/admin/api/workers/${id}`, headers, payload });
  assert.equal((await update({ ...settings, stops_on_disconnect: true })).json().stops_on_disconnect, true);
  // A client unaware of the field keeps the current choice.
  assert.equal((await update(settings)).json().stops_on_disconnect, true);
  await until(() => f.db.prepare('SELECT status FROM workers WHERE id=?').get(id).status === 'available');
  const job = (await f.inject('/v1/jobs', f.request)).json();
  await until(() => worker.calls === 1);
  assert.equal((await f.inject(`/v1/jobs/${job.id}/cancel`, {})).json().status, 'cancelled');
  await until(() => f.scheduler.running.size === 0 && worker.active === 0);
  assert.equal(f.db.prepare('SELECT status FROM attempts WHERE job_id=?').get(job.id).status, 'cancelled');
  assert.equal(f.scheduler.occupied(id), 0);
  assert.equal(f.db.prepare('SELECT status FROM workers WHERE id=?').get(id).status, 'available');
  const usage = f.service.publicJob(f.service.get(job.id)).usage;
  assert.equal(usage.estimated, true);
  assert.equal(usage.completion_tokens, f.request.max_tokens);
  f.service.submit(f.auth(), f.request, 'async');
  f.scheduler.tick();
  await until(() => worker.calls === 2);
});

test('Arrêt fiable déclaré : coupure réseau, délai dépassé et redémarrage restent incertains', async (t) => {
  const broken = await fixture(t);
  const brokenWorker = await mockWorker(t, { breakStream: true });
  const brokenId = addWorker(broken, brokenWorker);
  broken.db.prepare('UPDATE workers SET stops_on_disconnect=1').run();
  const response = await broken.inject('/v1/chat/completions', { ...broken.request, stream: true });
  assert.equal(broken.service.get(response.headers['x-job-id']).status, 'failed');
  assert.equal(broken.scheduler.occupied(brokenId), 1);

  const f = await fixture(t, { attemptTimeoutMs: 200 });
  const worker = await mockWorker(t, { hang: true });
  const id = addWorker(f, worker);
  f.db.prepare('UPDATE workers SET stops_on_disconnect=1').run();
  const timedOut = (await f.inject('/v1/jobs', f.request)).json();
  await until(
    () => f.db.prepare('SELECT status FROM attempts WHERE job_id=?').get(timedOut.id)?.status === 'uncertain',
  );
  const attempt = randomUUID();
  const running = f.service.submit(f.auth(), f.request, 'async').job;
  f.db
    .prepare(
      "INSERT INTO attempts(id,job_id,worker_id,status,started_at,deadline) VALUES (?,?,?,'running',?,?)",
    )
    .run(attempt, running.id, id, Date.now(), Date.now() + 60000);
  f.db
    .prepare("UPDATE jobs SET status='running',active_attempt_id=?,attempts=1 WHERE id=?")
    .run(attempt, running.id);
  await f.scheduler.stop();
  f.scheduler.recover();
  assert.equal(f.db.prepare('SELECT status FROM attempts WHERE id=?').get(attempt).status, 'uncertain');
  assert.equal(f.scheduler.occupied(id), 2);
});

test('Reprise après crash : file durable, tentative incertaine comptée une fois, chat interrompu', async (t) => {
  const f = await fixture(t);
  const worker = await mockWorker(t);
  const workerId = addWorker(f, worker);
  const queued = f.service.submit(f.auth(), f.request, 'async').job;
  const interrupted = f.service.submit(f.auth(), f.request, 'async').job;
  const chat = f.service.submit(f.auth(), f.request, 'chat').job;
  for (const j of [interrupted, chat]) {
    const attempt = randomUUID();
    f.db
      .prepare(
        "INSERT INTO attempts(id,job_id,worker_id,status,started_at,deadline) VALUES (?,?,?,'running',?,?)",
      )
      .run(attempt, j.id, workerId, Date.now(), Date.now() + 60000);
    f.db
      .prepare("UPDATE jobs SET status='running',active_attempt_id=?,attempts=1 WHERE id=?")
      .run(attempt, j.id);
  }
  await f.app.close();
  const restarted = await createServer({ ...f.config, logger: false, background: false });
  await restarted.ready();
  try {
    const { service, scheduler, db } = restarted.context;
    scheduler.recover();
    assert.equal(service.get(queued.id).status, 'queued');
    assert.equal(service.get(interrupted.id).status, 'queued');
    assert.equal(service.get(chat.id).status, 'failed');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM attempts WHERE status='uncertain'").get().n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM usage').get().n, 2);
    scheduler.recover();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM usage').get().n, 2);
  } finally {
    await restarted.close();
  }
});

test('Sauvegarde en ligne et restauration : jobs, quotas et secrets chiffrés conservés', async (t) => {
  const f = await fixture(t);
  const job = f.service.submit(f.auth(), f.request, 'async').job;
  const target = path.join(f.directory, 'backup.sqlite');
  await f.db.backup(target);
  const restored = openDatabase(target);
  try {
    assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(restored.prepare('SELECT id FROM jobs').get().id, job.id);
    assert.equal(restored.prepare('SELECT digest FROM api_keys').get().digest, f.auth().key.digest);
    assert.ok(!fs.readFileSync(target).includes(Buffer.from('callback-secret')));
  } finally {
    restored.close();
  }
});

test('Fenêtre glissante : expiration des usages, réservations et recharges', async (t) => {
  const f = await fixture(t);
  const worker = await mockWorker(t);
  addWorker(f, worker);
  const policy = {
    count: 'both',
    credit: { enabled: true, tokens: 200 },
    windows: [{ hours: 1, tokens: 200 }],
  };
  f.db.prepare('UPDATE applications SET policy=? WHERE id=?').run(json(policy), f.application);
  const job = (await f.inject('/v1/jobs', f.request)).json();
  await until(() => f.service.get(job.id).status === 'succeeded');
  const now = Date.now();
  let report = f.service.quotas.report('application', f.application, policy, now);
  assert.equal(report.credit.used, 7);
  assert.equal(report.windows[0].used, 7);
  assert.equal(report.credit.reserved, 0);
  f.db.prepare('UPDATE usage SET created_at=?').run(now - 3600001);
  report = f.service.quotas.report('application', f.application, policy, now);
  assert.equal(report.credit.used, 7);
  assert.equal(report.windows[0].used, 0);
  const headers = await adminLogin(f);
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: '/admin/api/credits',
        headers,
        payload: { scope: 'application', scope_id: f.application, tokens: 100, note: 'Recharge test' },
      })
    ).statusCode,
    200,
  );
  assert.equal(f.service.quotas.report('application', f.application, policy).credit.available, 293);
});

test('Vision, contenu malformé, saturation de file et authentification admin invalide', async (t) => {
  const f = await fixture(t, { maxQueued: 1 });
  assert.equal(
    (
      await f.inject('/v1/jobs', {
        ...f.request,
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://[' } }] }],
      })
    ).statusCode,
    400,
  );
  const job = await f.inject('/v1/jobs', {
    ...f.request,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Décrire' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } },
        ],
      },
    ],
  });
  assert.equal(job.statusCode, 202);
  assert.equal((await f.inject('/v1/jobs', f.request)).statusCode, 503);
  const invalid = await f.app.inject({
    method: 'POST',
    url: '/admin/api/login',
    payload: { username: 'missing', password: 'wrong' },
  });
  assert.equal(invalid.statusCode, 401);
});
