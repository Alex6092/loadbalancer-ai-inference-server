import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { fixture, adminLogin, mockWorker, addWorker, until } from './helpers.js';
import { json } from '../src/security.js';

test('OpenAPI 3.1 valide ; réponses HTTP conformes aux schémas de jobs et d’erreurs', async (t) => {
  await SwaggerParser.validate('docs/openapi.json');
  const spec = JSON.parse(fs.readFileSync('docs/openapi.json', 'utf8'));
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  ajv.addSchema({ $id: 'urn:providence:api', components: spec.components });
  const validateJob = ajv.compile({ $ref: 'urn:providence:api#/components/schemas/Job' });
  const validateError = ajv.compile({ $ref: 'urn:providence:api#/components/schemas/Error' });
  const f = await fixture(t);
  const specResponse = await f.app.inject('/openapi.json');
  assert.equal(specResponse.statusCode, 200);
  assert.equal(specResponse.json().openapi, '3.1.0');
  const created = await f.inject('/v1/jobs', f.request);
  assert.ok(validateJob(created.json()), JSON.stringify(validateJob.errors));
  const error = await f.inject('/v1/jobs', { ...f.request, model: 'missing' });
  assert.ok(validateError(error.json()), JSON.stringify(validateError.errors));
  const id = created.json().id;
  const cancelled = await f.inject(`/v1/jobs/${id}/cancel`, {});
  assert.ok(validateJob(cancelled.json()), JSON.stringify(validateJob.errors));
});

test('Les sondes de santé exposent le SHA configuré pour vérifier un déploiement', async (t) => {
  const release = '0123456789abcdef0123456789abcdef01234567';
  const f = await fixture(t, { release });
  for (const endpoint of ['/health/live', '/health/ready']) {
    const response = await f.app.inject(endpoint);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok', release });
  }
});

test('Administration : configuration complète, modèle vision, budgets et pagination', async (t) => {
  const f = await fixture(t);
  const headers = await adminLogin(f);
  const call = (url, body, method = 'POST') =>
    f.app.inject({
      url: `/admin/api${url}`,
      method,
      headers,
      ...(body === undefined ? {} : { payload: body }),
    });
  const model = await call('/models', {
    id: 'vision-model',
    context_tokens: 32768,
    max_output_tokens: 512,
    input_tokens_per_char: 1,
    image_tokens: 2048,
    vision: true,
  });
  assert.equal(model.statusCode, 200);
  const worker = await mockWorker(t, { models: ['vision-model'] });
  const registered = await call('/workers', {
    name: 'Vision',
    url: worker.url,
    models: ['vision-model'],
    concurrency: 2,
    secret: 'worker-secret',
    enabled: true,
  });
  assert.equal(registered.statusCode, 200);
  assert.ok(!registered.body.includes('worker-secret'));
  await until(() => !f.scheduler.probing.size);
  const first = f.service.submit(f.auth(), f.request, 'async').job;
  const second = f.service.submit(f.auth(), f.request, 'async').job;
  f.service.finish(first.id, 'cancelled');
  const filtered = await call('/jobs?status=queued&limit=1', undefined, 'GET');
  assert.equal(filtered.json().total, 1);
  assert.equal(filtered.json().data[0].id, second.id);
  const queried = await call(`/jobs?search=${first.id.slice(0, 8)}`, undefined, 'GET');
  assert.equal(queried.json().total, 1);
  const all = await call('/jobs?offset=1&limit=1', undefined, 'GET');
  assert.equal(all.json().data.length, 1);
  assert.equal(all.json().total, 2);
  const snapshot = (await call('/snapshot', undefined, 'GET')).json();
  assert.equal(snapshot.workers[0].has_secret, true);
  assert.equal(snapshot.workers[0].secret, undefined);
});

test('Une échéance de fenêtre glissante calculable produit Retry-After', async (t) => {
  const f = await fixture(t);
  const worker = await mockWorker(t);
  addWorker(f, worker);
  const job = (await f.inject('/v1/jobs', f.request)).json();
  await until(() => f.service.get(job.id).status === 'succeeded');
  f.db
    .prepare('UPDATE applications SET policy=? WHERE id=?')
    .run(json({ count: 'output', windows: [{ hours: 1, tokens: 32 }] }), f.application);
  const refused = await f.inject('/v1/jobs', f.request);
  assert.equal(refused.statusCode, 429);
  assert.ok(refused.json().error.details.retry_at);
  assert.ok(Number(refused.headers['retry-after']) > 0);
});

test('Politique régularisée : un dépassement réel bloque ensuite, et la désactivation lève la restriction', async (t) => {
  const f = await fixture(t);
  const worker = await mockWorker(t);
  addWorker(f, worker);
  f.db
    .prepare('UPDATE applications SET policy=? WHERE id=?')
    .run(json({ count: 'output', credit: { enabled: true, tokens: 1 } }), f.application);
  const job = (await f.inject('/v1/jobs', { ...f.request, max_tokens: 1 })).json();
  await until(() => f.service.get(job.id).status === 'succeeded');
  assert.equal(f.service.quotas.reports(f.service.get(job.id))[0].credit.available, -1);
  assert.equal((await f.inject('/v1/jobs', { ...f.request, max_tokens: 1 })).statusCode, 429);
  f.db.prepare('UPDATE applications SET policy=? WHERE id=?').run('{}', f.application);
  assert.equal((await f.inject('/v1/jobs', { ...f.request, max_tokens: 1 })).statusCode, 202);
});
