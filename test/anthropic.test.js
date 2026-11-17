import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Ajv from 'ajv';
import { fixture, addWorker, mockWorker, until, adminLogin } from './helpers.js';
import { encrypt, json } from '../src/security.js';
import { providerFor } from '../src/providers.js';
import { openDatabase } from '../src/db.js';

const usage = {
  input_tokens: 5,
  cache_creation_input_tokens: 3,
  cache_read_input_tokens: 7,
  output_tokens: 2,
};
const answer = (overrides = {}) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'resolved-model',
  content: [{ type: 'text', text: 'Bonjour é🌍' }],
  stop_reason: 'end_turn',
  usage,
  ...overrides,
});
const tools = [
  {
    type: 'function',
    function: {
      name: 'weather',
      description: 'Météo',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
        additionalProperties: false,
      },
      strict: true,
    },
  },
];
const toolCall = (id, city) => ({
  id,
  type: 'function',
  function: { name: 'weather', arguments: json({ city }) },
});

function events(body) {
  const frames = [
    {
      type: 'message_start',
      message: {
        ...body,
        content: [],
        stop_reason: null,
        usage: body.usage ? { ...body.usage, output_tokens: 1 } : undefined,
      },
    },
    { type: 'ping' },
  ];
  for (const [index, block] of body.content.entries()) {
    frames.push({
      type: 'content_block_start',
      index,
      content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} },
    });
    const value = block.type === 'text' ? block.text : json(block.input);
    for (const text of [value.slice(0, 3), value.slice(3)])
      frames.push({
        type: 'content_block_delta',
        index,
        delta:
          block.type === 'text'
            ? { type: 'text_delta', text }
            : { type: 'input_json_delta', partial_json: text },
      });
    frames.push({ type: 'content_block_stop', index });
  }
  frames.push({ type: 'future_notification' });
  frames.push({ type: 'message_delta', delta: { stop_reason: body.stop_reason }, usage: body.usage });
  frames.push({ type: 'message_delta', delta: {}, usage: body.usage });
  frames.push({ type: 'message_stop' });
  return frames;
}

async function nativeWorker(t, behavior = {}) {
  const state = { requests: [], probes: [], closed: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://worker');
    if (req.method === 'GET') {
      state.probes.push({ path: req.url, headers: req.headers });
      const response = behavior.catalog?.(url) ?? { data: [{ id: 'test-model' }], has_more: false };
      res.writeHead(response.status || 200, { 'Content-Type': 'application/json' });
      res.end(json(response));
      return;
    }
    if (req.url !== '/v1/messages') {
      res.writeHead(404);
      res.end();
      return;
    }
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    state.requests.push({ body, headers: req.headers });
    res.on('close', () => {
      state.closed++;
    });
    if (behavior.hang) return;
    const status = typeof behavior.status === 'function' ? behavior.status(body) : behavior.status || 200;
    res.writeHead(status, {
      'Content-Type': body.stream && status === 200 ? 'text/event-stream' : 'application/json',
    });
    if (status !== 200) {
      res.end(json({ type: 'error', error: { message: 'secret upstream error' } }));
      return;
    }
    const result =
      typeof behavior.response === 'function' ? behavior.response(body) : behavior.response || answer();
    if (!body.stream) {
      res.end(json(result));
      return;
    }
    const frames = behavior.frames || events(result);
    const wire = Buffer.from(frames.map((e) => `event: ${e.type}\r\ndata: ${json(e)}\r\n\r\n`).join(''));
    const step = behavior.fragment ? 7 : wire.length;
    for (let offset = 0; offset < wire.length; offset += step) {
      if (res.destroyed) return;
      res.write(wire.subarray(offset, offset + step));
      if (behavior.fragment) await new Promise((resolve) => setImmediate(resolve));
    }
    if (!behavior.hangStream) res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  state.url = `http://127.0.0.1:${server.address().port}/v1`;
  return state;
}
function addNative(f, worker) {
  const id = addWorker(f, worker);
  f.db
    .prepare(
      "UPDATE workers SET provider='anthropic', secret=?, anthropic_workspace_id='wrk_test' WHERE id=?",
    )
    .run(encrypt('native-secret', f.config.encryptionKey), id);
  return id;
}
function chunks(response) {
  return response.body
    .split(/\n\n/)
    .filter((s) => s.startsWith('data: ') && s !== 'data: [DONE]')
    .map((s) => JSON.parse(s.slice(6)));
}

test('Anthropic : chat, job et callback gardent le contrat OpenAI et comptent le cache', async (t) => {
  const f = await fixture(t);
  const worker = await nativeWorker(t);
  addNative(f, worker);
  const sync = await f.inject('/v1/chat/completions', f.request);
  assert.equal(sync.statusCode, 200);
  assert.equal(sync.json().model, 'test-model');
  assert.equal(sync.json().object, 'chat.completion');
  assert.equal(sync.json().choices[0].message.content, 'Bonjour é🌍');
  assert.deepEqual(sync.json().usage, { prompt_tokens: 15, completion_tokens: 2, total_tokens: 17 });
  assert.equal(worker.requests[0].headers['x-api-key'], 'native-secret');
  assert.equal(worker.requests[0].headers.authorization, undefined);
  assert.equal(worker.requests[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(worker.requests[0].headers['anthropic-workspace-id'], 'wrk_test');
  f.db
    .prepare('UPDATE applications SET callback_bases=? WHERE id=?')
    .run(json(['https://callback.example/hooks']), f.application);
  const created = (
    await f.inject('/v1/jobs', { ...f.request, callbackURL: 'https://callback.example/hooks/result' })
  ).json();
  await until(() => f.service.get(created.id).status === 'succeeded');
  const job = (await f.inject(`/v1/jobs/${created.id}`)).json();
  assert.deepEqual({ ...job.result, created: 0 }, { ...sync.json(), created: 0 });
  assert.equal(job.usage.prompt_tokens, 15);
  const callback = JSON.parse(
    f.db.prepare('SELECT payload FROM callbacks WHERE job_id=?').get(created.id).payload,
  );
  assert.deepEqual(callback.result, job.result);
  assert.equal(worker.requests[1].body.callbackURL, undefined);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM reservations').get().n, 0);
});

test('Anthropic : conversion vision, système, outils et schéma sans mutation du payload', async (t) => {
  const f = await fixture(t);
  const worker = await nativeWorker(t, {
    response: answer({ content: [{ type: 'text', text: '{"city":"Paris"}' }] }),
  });
  addNative(f, worker);
  const request = {
    ...f.request,
    max_tokens: undefined,
    max_completion_tokens: 32,
    temperature: 0.5,
    top_p: 0.9,
    stop: 'FIN',
    user: 'opaque-user',
    n: 1,
    tools,
    tool_choice: { type: 'function', function: { name: 'weather' } },
    parallel_tool_calls: false,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'city', strict: true, schema: tools[0].function.parameters },
    },
    messages: [
      { role: 'system', content: 'Système' },
      { role: 'developer', content: [{ type: 'text', text: 'Développeur' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Compare' },
          { type: 'image_url', image_url: { url: 'https://example.test/photo.png', detail: 'auto' } },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,YWJj' } },
        ],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('call_1', 'Paris'), toolCall('call_2', 'Lyon')],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '20°C' },
      { role: 'tool', tool_call_id: 'call_2', content: '18°C' },
    ],
  };
  const before = json(request);
  const response = await f.inject('/v1/chat/completions', request);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(json(request), before);
  const sent = worker.requests[0].body;
  assert.deepEqual(
    sent.system.map((b) => b.text),
    ['Système', 'Développeur'],
  );
  assert.equal(sent.messages.length, 3);
  assert.equal(sent.messages[0].content[1].source.type, 'url');
  assert.deepEqual(sent.messages[0].content[2].source, {
    type: 'base64',
    media_type: 'image/jpeg',
    data: 'YWJj',
  });
  assert.deepEqual(sent.messages[1].content[0], {
    type: 'tool_use',
    id: 'call_1',
    name: 'weather',
    input: { city: 'Paris' },
  });
  assert.deepEqual(
    sent.messages[2].content.map((b) => b.tool_use_id),
    ['call_1', 'call_2'],
  );
  assert.equal(sent.tools[0].strict, true);
  assert.deepEqual(sent.tool_choice, { type: 'tool', name: 'weather', disable_parallel_tool_use: true });
  assert.deepEqual(sent.output_config.format.schema, request.response_format.json_schema.schema);
  assert.equal(sent.max_tokens, 32);
  assert.equal(sent.max_completion_tokens, undefined);
  assert.deepEqual(sent.stop_sequences, ['FIN']);
  assert.equal(sent.metadata.user_id, 'opaque-user');
});

test('Anthropic : streaming fragmenté UTF-8/CRLF, outils multiples et usage cumulatif', async (t) => {
  const f = await fixture(t);
  const worker = await nativeWorker(t, {
    fragment: true,
    response: answer({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Météo é🌍' },
        { type: 'tool_use', id: 'call_1', name: 'weather', input: { city: 'Paris' } },
        { type: 'tool_use', id: 'call_2', name: 'weather', input: {} },
      ],
    }),
  });
  addNative(f, worker);
  const response = await f.inject('/v1/chat/completions', { ...f.request, stream: true, tools });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.match(/data: \[DONE\]/g).length, 1);
  const output = chunks(response);
  assert.ok(output.every((c) => c.object === 'chat.completion.chunk' && c.model === 'test-model'));
  assert.equal(
    output
      .flatMap((c) => c.choices)
      .map((c) => c.delta.content || '')
      .join(''),
    'Météo é🌍',
  );
  assert.equal(output.at(-2).choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(output.at(-1).usage, { prompt_tokens: 15, completion_tokens: 2, total_tokens: 17 });
  const job = (await f.inject(`/v1/jobs/${response.headers['x-job-id']}`)).json();
  assert.equal(job.status, 'succeeded');
  assert.equal(job.result.choices[0].message.tool_calls.length, 2);
  assert.deepEqual(job.result.choices[0].message.tool_calls[0], toolCall('call_1', 'Paris'));
  assert.equal(job.result.choices[0].message.tool_calls[1].function.arguments, '{}');
  assert.equal(job.usage.total_tokens, 17);
  assert.equal(worker.requests[0].body.stream_options, undefined);
});

test('Anthropic : ancien format functions, historique et sortie synchrone/streaming', async (t) => {
  const f = await fixture(t);
  const worker = await nativeWorker(t, {
    response: answer({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'call_1', name: 'weather', input: { city: 'Paris' } }],
    }),
  });
  addNative(f, worker);
  for (const stream of [false, true]) {
    const response = await f.inject('/v1/chat/completions', {
      ...f.request,
      stream,
      functions: [tools[0].function],
      function_call: { name: 'weather' },
      messages: [
        ...f.request.messages,
        { role: 'assistant', function_call: { name: 'weather', arguments: '{"city":"Lyon"}' } },
        { role: 'function', name: 'weather', content: '18°C' },
      ],
    });
    assert.equal(response.statusCode, 200, response.body);
    const result = stream
      ? (await f.inject(`/v1/jobs/${response.headers['x-job-id']}`)).json().result
      : response.json();
    assert.equal(result.choices[0].finish_reason, 'function_call');
    assert.deepEqual(result.choices[0].message.function_call, {
      name: 'weather',
      arguments: '{"city":"Paris"}',
    });
    assert.equal(result.choices[0].message.tool_calls, undefined);
    assert.equal(worker.requests.at(-1).body.tool_choice.disable_parallel_tool_use, true);
    assert.equal(worker.requests.at(-1).body.messages[2].content[0].tool_use_id, 'legacy_1');
  }
});

test('Anthropic : options propres aux autres backends ignorées en chat et streaming', async (t) => {
  const f = await fixture(t);
  const worker = await nativeWorker(t);
  addNative(f, worker);
  for (const enable_thinking of [true, false]) {
    for (const stream of [false, true]) {
      const request = {
        ...f.request,
        stream,
        enable_thinking,
        seed: 42,
        frequency_penalty: 0.2,
        presence_penalty: 0.1,
        repetition_penalty: 1.1,
        top_k: 40,
        min_p: 0.05,
        reasoning_effort: 'high',
        chat_template_kwargs: { enable_thinking },
        extra_body: { enable_thinking, model: 'other-model', max_tokens: 1000000 },
      };
      const original = json(request);
      const response = await f.inject('/v1/chat/completions', request);
      assert.equal(response.statusCode, 200, response.body);
      const job = (await f.inject(`/v1/jobs/${response.headers['x-job-id']}`)).json();
      assert.equal(job.status, 'succeeded');
      assert.equal(json(request), original);
      assert.equal(JSON.parse(f.service.get(job.id).request).enable_thinking, enable_thinking);
      assert.deepEqual(worker.requests.at(-1).body, {
        model: 'test-model',
        max_tokens: 32,
        stream,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Bonjour' }] }],
      });
    }
  }
});

test('Options ignorées : jobs idempotents et transmission intégrale aux workers OpenAI', async (t) => {
  const f = await fixture(t);
  const native = await nativeWorker(t);
  const nativeId = addNative(f, native);
  const request = {
    ...f.request,
    enable_thinking: false,
    seed: 42,
    chat_template_kwargs: { enable_thinking: false },
  };
  const options = { headers: { ...f.headers, 'idempotency-key': 'ignored-options' } };
  const submitted = await f.inject('/v1/jobs', request, options);
  assert.equal(submitted.statusCode, 202, submitted.body);
  await until(() => f.service.get(submitted.json().id).status === 'succeeded');
  const replay = await f.inject('/v1/jobs', request, options);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().id, submitted.json().id);
  assert.equal((await f.inject('/v1/jobs', { ...request, enable_thinking: true }, options)).statusCode, 409);
  assert.equal(native.requests.length, 1);
  assert.equal(native.requests[0].body.enable_thinking, undefined);
  f.db.prepare('UPDATE workers SET enabled=0 WHERE id=?').run(nativeId);
  const openai = await mockWorker(t);
  addWorker(f, openai);
  const response = await f.inject('/v1/chat/completions', request);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(openai.requests[0], { ...request, stream: false });
});

test('Anthropic : paramètres incompatibles rejetés avant job, réservation ou appel', async (t) => {
  const f = await fixture(t);
  const worker = await nativeWorker(t);
  addNative(f, worker);
  const invalid = [
    { response_format: { type: 'json_object' } },
    { temperature: 1.5 },
    { tools: [{ type: 'custom' }] },
    { tools, tool_choice: { type: 'function', function: { name: 'missing' } } },
    { messages: [{ role: 'tool', tool_call_id: 'missing', content: 'x' }] },
    {
      messages: [
        {
          role: 'assistant',
          tool_calls: [{ ...toolCall('c', 'Paris'), function: { name: 'weather', arguments: '{' } }],
        },
      ],
    },
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://example.test/x.png', detail: 'high' } }],
        },
      ],
    },
    { stream_options: { something_unknown: true } },
  ];
  for (const extra of invalid) {
    const response = await f.inject('/v1/jobs', { ...f.request, ...extra });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, 'unsupported_worker_parameter');
    assert.ok(response.json().error.details.field);
  }
  assert.equal(worker.requests.length, 0);
  for (const table of ['jobs', 'attempts', 'reservations', 'usage'])
    assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  assert.equal(f.db.prepare('SELECT status FROM workers').get().status, 'available');
});

test('Routage mixte : choisir le protocole compatible, attendre son retour, revalider en file', async (t) => {
  const f = await fixture(t);
  const native = await nativeWorker(t);
  const nativeId = addNative(f, native);
  const openai = await mockWorker(t);
  const openaiId = addWorker(f, openai);
  f.db.prepare("UPDATE workers SET status='unavailable' WHERE id=?").run(openaiId);
  const created = (
    await f.inject('/v1/jobs', { ...f.request, response_format: { type: 'json_object' } })
  ).json();
  f.scheduler.tick();
  assert.equal(f.service.get(created.id).status, 'queued');
  assert.equal(native.requests.length, 0);
  f.db.prepare("UPDATE workers SET status='available' WHERE id=?").run(openaiId);
  f.scheduler.tick();
  await until(() => f.service.get(created.id).status === 'succeeded');
  assert.equal(openai.calls, 1);
  assert.equal(native.requests.length, 0);
  f.db.prepare("UPDATE workers SET status='unavailable'").run();
  const changed = (
    await f.inject('/v1/jobs', { ...f.request, response_format: { type: 'json_object' } })
  ).json();
  f.db.prepare("UPDATE workers SET provider='anthropic' WHERE id=?").run(openaiId);
  f.scheduler.tick();
  assert.equal(f.service.get(changed.id).status, 'failed');
  assert.equal(f.service.get(changed.id).attempts, 0);
  assert.equal(f.scheduler.occupied(nativeId), 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM reservations').get().n, 0);
});

test('Anthropic : contrôle paginé et alias, authentification et pagination invalide', async (t) => {
  const f = await fixture(t);
  const worker = await nativeWorker(t, {
    catalog: (url) => {
      if (url.pathname.endsWith('/models/test-model')) return { type: 'model', id: 'resolved-model' };
      return url.searchParams.has('after_id')
        ? { data: [{ id: 'another-model' }], has_more: false }
        : { data: [{ id: 'first' }], has_more: true, last_id: 'first' };
    },
  });
  const id = addNative(f, worker);
  await f.scheduler.probe(f.db.prepare('SELECT * FROM workers WHERE id=?').get(id));
  assert.equal(f.db.prepare('SELECT status FROM workers WHERE id=?').get(id).status, 'available');
  assert.deepEqual(
    worker.probes.map((p) => p.path),
    ['/v1/models', '/v1/models?after_id=first', '/v1/models/test-model'],
  );
  assert.ok(worker.probes.every((p) => p.headers['x-api-key'] === 'native-secret'));
  const broken = await nativeWorker(t, { catalog: () => ({ data: [], has_more: true, last_id: 'loop' }) });
  const brokenId = addNative(f, broken);
  await f.scheduler.probe(f.db.prepare('SELECT * FROM workers WHERE id=?').get(brokenId));
  assert.equal(f.db.prepare('SELECT status FROM workers WHERE id=?').get(brokenId).status, 'unavailable');
  assert.equal(broken.probes.length, 2);
});

for (const status of [400, 401, 429, 529])
  test(`Anthropic : HTTP ${status}, réessais et zéro token pour un rejet`, async (t) => {
    const retry = status >= 500 || status === 429;
    const f = await fixture(t, { maxAttempts: 2 });
    const worker = await nativeWorker(t, { status });
    const id = addNative(f, worker);
    const created = (await f.inject('/v1/jobs', f.request)).json();
    await until(
      () => f.service.get(created.id).attempts === 1 && f.service.get(created.id).status !== 'running',
    );
    assert.equal(f.service.get(created.id).status, retry ? 'queued' : 'failed');
    if (retry) {
      f.db.prepare("UPDATE workers SET status='available' WHERE id=?").run(id);
      f.db.prepare('UPDATE jobs SET available_at=0 WHERE id=?').run(created.id);
      f.scheduler.tick();
      await until(() => f.service.get(created.id).status === 'failed');
    }
    const job = (await f.inject(`/v1/jobs/${created.id}`)).json();
    assert.equal(job.usage.total_tokens, 0);
    assert.equal(worker.requests.length, retry ? 2 : 1);
    assert.equal(f.scheduler.occupied(id), 0);
    assert.doesNotMatch(json(job.error), /secret upstream/);
  });

for (const errorEvent of [false, true])
  test(`Anthropic : ${errorEvent ? 'erreur SSE' : 'flux tronqué'} après exposition sans rejeu`, async (t) => {
    const f = await fixture(t);
    const frames = events(answer()).slice(0, -3);
    if (errorEvent)
      frames.push({ type: 'error', error: { type: 'overloaded_error', message: 'secret upstream error' } });
    const worker = await nativeWorker(t, { frames });
    const id = addNative(f, worker);
    const response = await f.inject('/v1/chat/completions', { ...f.request, stream: true });
    assert.match(response.body, /Bonjour|jour/);
    assert.equal(chunks(response).at(-1).error.code, 'worker_unavailable');
    assert.equal(response.body.match(/data: \[DONE\]/g).length, 1);
    const job = (await f.inject(`/v1/jobs/${response.headers['x-job-id']}`)).json();
    assert.equal(job.status, 'failed');
    assert.equal(job.usage.estimated, true);
    assert.equal(worker.requests.length, 1);
    assert.equal(f.scheduler.occupied(id), 1);
    assert.doesNotMatch(response.body, /secret upstream/);
  });

test('Anthropic : annulation ferme la connexion et conserve une tentative incertaine par défaut', async (t) => {
  const f = await fixture(t);
  const worker = await nativeWorker(t, { hang: true });
  const id = addNative(f, worker);
  const created = (await f.inject('/v1/jobs', f.request)).json();
  await until(() => worker.requests.length === 1);
  await f.inject(`/v1/jobs/${created.id}/cancel`, {});
  await until(() => f.scheduler.running.size === 0 && worker.closed === 1);
  assert.equal(f.service.get(created.id).status, 'cancelled');
  assert.equal(f.scheduler.occupied(id), 1);
  assert.equal(
    f.db.prepare('SELECT status FROM attempts WHERE job_id=?').get(created.id).status,
    'uncertain',
  );
});

test('Anthropic : arrêt fiable explicite, délai dépassé et bilan manquant', async (t) => {
  const f = await fixture(t, { attemptTimeoutMs: 150, maxAttempts: 1 });
  const worker = await nativeWorker(t, { hang: true });
  const id = addNative(f, worker);
  f.db.prepare('UPDATE workers SET stops_on_disconnect=1 WHERE id=?').run(id);
  let created = (await f.inject('/v1/jobs', f.request)).json();
  await until(() => worker.requests.length === 1);
  await f.inject(`/v1/jobs/${created.id}/cancel`, {});
  await until(() => f.scheduler.running.size === 0);
  assert.equal(f.scheduler.occupied(id), 0);
  created = (await f.inject('/v1/jobs', f.request)).json();
  await until(() => f.service.get(created.id).status === 'failed');
  assert.equal(f.scheduler.occupied(id), 1);
  const good = await nativeWorker(t, { response: answer({ usage: undefined }) });
  addNative(f, good);
  for (const stream of [false, true]) {
    const response = await f.inject('/v1/chat/completions', { ...f.request, stream });
    const job = (await f.inject(`/v1/jobs/${response.headers['x-job-id']}`)).json();
    assert.equal(job.status, 'succeeded');
    assert.equal(job.usage.estimated, true);
  }
});

test('Administration Anthropic : secrets masqués, valeurs conservées et verrou de connexion occupée', async (t) => {
  const f = await fixture(t);
  const headers = await adminLogin(f);
  const worker = await nativeWorker(t, { hang: true });
  const body = {
    name: 'Claude',
    url: worker.url,
    provider: 'anthropic',
    secret: 'native-secret',
    models: ['test-model'],
    concurrency: 1,
    enabled: true,
    anthropic_workspace_id: 'wrk_test',
  };
  const create = await f.app.inject({ method: 'POST', url: '/admin/api/workers', headers, payload: body });
  assert.equal(create.statusCode, 200, create.body);
  const id = create.json().id;
  assert.equal(create.json().provider, 'anthropic');
  assert.equal(create.json().anthropic_version, '2023-06-01');
  assert.equal(create.json().stops_on_disconnect, false);
  assert.equal(create.json().has_secret, true);
  assert.equal(create.json().secret, undefined);
  await until(() => f.db.prepare('SELECT status FROM workers WHERE id=?').get(id).status === 'available');
  const { provider, secret, anthropic_workspace_id, ...oldClient } = body;
  let update = await f.app.inject({
    method: 'PUT',
    url: `/admin/api/workers/${id}`,
    headers,
    payload: oldClient,
  });
  assert.equal(update.statusCode, 200);
  assert.equal(update.json().provider, 'anthropic');
  assert.equal(update.json().anthropic_workspace_id, 'wrk_test');
  await until(() => f.db.prepare('SELECT status FROM workers WHERE id=?').get(id).status === 'available');
  const created = (await f.inject('/v1/jobs', f.request)).json();
  await until(() => worker.requests.length === 1);
  for (const extra of [
    { provider: 'openai' },
    { anthropic_version: '2026-10-21' },
    { anthropic_workspace_id: 'other' },
  ]) {
    update = await f.app.inject({
      method: 'PUT',
      url: `/admin/api/workers/${id}`,
      headers,
      payload: { ...oldClient, ...extra },
    });
    assert.equal(update.statusCode, 409, update.body);
  }
  await f.inject(`/v1/jobs/${created.id}/cancel`, {});
  await until(() => f.scheduler.running.size === 0);
  update = await f.app.inject({
    method: 'PUT',
    url: `/admin/api/workers/${id}`,
    headers,
    payload: { ...oldClient, provider: 'openai' },
  });
  assert.equal(update.statusCode, 409);
  for (const extra of [
    { provider: 'unknown' },
    { anthropic_version: 'bad\r\nheader' },
    { anthropic_workspace_id: 'bad\nheader' },
  ]) {
    const invalid = await f.app.inject({
      method: 'POST',
      url: '/admin/api/workers',
      headers,
      payload: { ...body, ...extra },
    });
    assert.equal(invalid.statusCode, 400);
  }
});

test('Migration : workers existants restent OpenAI avec leurs secrets et réglages', async (t) => {
  const f = await fixture(t);
  const worker = await mockWorker(t);
  const id = addWorker(f, worker);
  f.db
    .prepare('UPDATE workers SET secret=?, stops_on_disconnect=1 WHERE id=?')
    .run(encrypt('keep-me', f.config.encryptionKey), id);
  const original = f.db.prepare('SELECT * FROM workers WHERE id=?').get(id);
  f.db.exec(
    'ALTER TABLE workers DROP COLUMN anthropic_workspace_id; ALTER TABLE workers DROP COLUMN anthropic_version; ALTER TABLE workers DROP COLUMN provider; DELETE FROM migrations WHERE version=3;',
  );
  await f.app.close();
  const db = openDatabase(f.config.database);
  try {
    const restored = db.prepare('SELECT * FROM workers WHERE id=?').get(id);
    assert.equal(restored.provider, 'openai');
    assert.equal(restored.secret, original.secret);
    assert.equal(restored.stops_on_disconnect, 1);
    assert.equal(db.prepare('SELECT MAX(version) n FROM migrations').get().n, 3);
  } finally {
    db.close();
  }
});

test('Adaptateur : version récente et motifs de fin explicites', () => {
  const worker = { provider: 'anthropic', anthropic_version: '2026-10-21' };
  const provider = providerFor(worker);
  const request = { model: 'test', messages: [{ role: 'user', content: 'x' }], max_tokens: 32 };
  assert.equal(provider.prepare({ ...request, temperature: 0.2 }, worker).temperature, undefined);
  for (const [stop_reason, expected] of [
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['max_tokens', 'length'],
    ['model_context_window_exceeded', 'length'],
    ['refusal', 'content_filter'],
  ])
    assert.equal(provider.response(answer({ stop_reason }), request).choices[0].finish_reason, expected);
  assert.throws(() => provider.response(answer({ stop_reason: 'pause_turn' }), request), /fin Anthropic/);
});

test('Anthropic : le compteur initial ne remplace pas un usage final absent', async (t) => {
  const f = await fixture(t);
  const frames = events(answer()).map((event) =>
    event.type === 'message_delta' ? { ...event, usage: undefined } : event,
  );
  const worker = await nativeWorker(t, { frames });
  addNative(f, worker);
  const response = await f.inject('/v1/chat/completions', { ...f.request, stream: true });
  const job = (await f.inject(`/v1/jobs/${response.headers['x-job-id']}`)).json();
  assert.equal(job.status, 'succeeded');
  assert.equal(job.usage.estimated, true);
  assert.ok(chunks(response).every((chunk) => !chunk.usage));
});

test('Parseur partagé : flux OpenAI découpé octet par octet et espaces SSE conservés compatibles', async () => {
  const chunk = { id: 'chat_test', choices: [{ index: 0, delta: { content: 'é🌍' }, finish_reason: null }] };
  const wire = Buffer.from(`: heartbeat\r\n\r\ndata: ${json(chunk)}\r\n\r\ndata:   [DONE]\r\n\r\n`);
  let offset = 0;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (offset < wire.length) controller.enqueue(wire.subarray(offset, ++offset));
        else controller.close();
      },
    }),
  );
  const received = [];
  for await (const value of providerFor({ provider: 'openai' }).stream(response, {}, wire.length))
    received.push(value);
  assert.deepEqual(received, [chunk]);
});

test('Haiku 5.5 : correction structurée avec temperature et score borné en chat, streaming et job', async (t) => {
  const f = await fixture(t);
  const model = 'claude-haiku-5-5';
  f.db.prepare('INSERT INTO models VALUES (?, ?, ?, ?, ?, ?)').run(model, 32768, 8192, 1, 1024, 1);
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      score: { type: 'integer', minimum: 0, maximum: 100, description: 'Pourcentage de maîtrise.' },
      feedback: { type: 'string' },
    },
    required: ['score', 'feedback'],
  };
  const result = { score: 75, feedback: 'Réponse satisfaisante.' };
  const worker = await nativeWorker(t, {
    status: (body) =>
      body.temperature !== undefined ||
      body.top_p !== undefined ||
      body.output_config?.format.schema.properties.score.minimum !== undefined ||
      body.output_config?.format.schema.properties.score.maximum !== undefined
        ? 400
        : 200,
    response: answer({ model, content: [{ type: 'text', text: json(result) }] }),
  });
  const id = addNative(f, worker);
  f.db.prepare('UPDATE workers SET models=? WHERE id=?').run(json([model]), id);
  const request = {
    model,
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 6144,
    messages: [
      { role: 'system', content: 'Retourne une correction structurée.' },
      { role: 'user', content: 'Copie fictive.' },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'correction', strict: true, schema } },
    enable_thinking: false,
    chat_template_kwargs: { enable_thinking: false },
  };
  for (const stream of [false, true]) {
    const response = await f.inject('/v1/chat/completions', { ...request, stream });
    assert.equal(response.statusCode, 200, response.body);
    const job = (await f.inject(`/v1/jobs/${response.headers['x-job-id']}`)).json();
    assert.equal(job.status, 'succeeded');
    assert.deepEqual(JSON.parse(job.result.choices[0].message.content), result);
  }
  const submitted = await f.inject('/v1/jobs', request);
  assert.equal(submitted.statusCode, 202, submitted.body);
  await until(() => f.service.get(submitted.json().id).status === 'succeeded');
  const stored = JSON.parse(f.service.get(submitted.json().id).request);
  assert.equal(stored.temperature, 0.2);
  assert.deepEqual(stored.response_format.json_schema.schema, schema);
  const score = worker.requests[0].body.output_config.format.schema.properties.score;
  assert.deepEqual(
    score.enum,
    Array.from({ length: 101 }, (_, index) => index),
  );
  assert.equal(score.description, schema.properties.score.description);
  assert.ok(new Ajv().validate(schema, result));
  assert.ok(!new Ajv().validate(schema, { ...result, score: 101 }));
});

test('Schémas Anthropic : équivalence des domaines entiers, imbrication et données littérales préservées', () => {
  const provider = providerFor({ provider: 'anthropic' });
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      score: { type: 'integer', minimum: 0, maximum: 100 },
      minimum: { type: 'integer', minimum: -2, maximum: 2, enum: [-3, -1, 1, 3] },
      items: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 3 } },
      literal: { const: { type: 'integer', minimum: 0, maximum: 100 } },
    },
    required: ['score'],
    $defs: { grade: { type: 'integer', minimum: 0, maximum: 20 } },
  };
  const snapshot = json(schema);
  const request = {
    model: 'test',
    messages: [{ role: 'user', content: 'x' }],
    max_tokens: 32,
    response_format: { type: 'json_schema', json_schema: { schema } },
    tools: [{ type: 'function', function: { name: 'grade', strict: true, parameters: schema } }],
  };
  const prepared = provider.prepare(request, {});
  const translated = prepared.output_config.format.schema;
  const ajv = new Ajv();
  const before = ajv.compile(schema);
  const after = ajv.compile(translated);
  for (const score of [-1, 0, 1, 75, 99, 100, 101, 1.5, '75', null]) {
    for (const minimum of [-3, -1, 0, 1, 3]) {
      const example = { score, minimum, items: [0, 3], literal: schema.properties.literal.const };
      assert.equal(after(example), before(example), json(example));
    }
  }
  assert.deepEqual(translated.properties.minimum.enum, [-1, 1]);
  assert.deepEqual(translated.properties.literal, schema.properties.literal);
  assert.deepEqual(
    translated.$defs.grade.enum,
    Array.from({ length: 21 }, (_, index) => index),
  );
  assert.deepEqual(prepared.tools[0].input_schema, translated);
  assert.equal(json(schema), snapshot);
  for (const bounds of [
    { type: 'number', minimum: 0, maximum: 100 },
    { type: 'integer', minimum: 0, maximum: 1000000 },
    { type: 'integer', minimum: 0 },
    { type: 'integer', minimum: 10, maximum: 5 },
  ]) {
    const original = {
      ...request,
      response_format: { type: 'json_schema', json_schema: { schema: bounds } },
    };
    assert.deepEqual(provider.prepare(original, {}).output_config.format.schema, bounds);
  }
  const openai = providerFor({ provider: 'openai' }).prepare(request);
  assert.deepEqual(openai.response_format.json_schema.schema, schema);
});

test('Échantillonnage : versions Anthropic et modèles récents sans modifier les autres backends', () => {
  const provider = providerFor({ provider: 'anthropic' });
  const request = {
    model: 'test',
    messages: [{ role: 'user', content: 'x' }],
    max_tokens: 32,
    temperature: 0.2,
    top_p: 0.8,
  };
  for (const model of [
    'claude-haiku-5-5',
    'claude-sonnet-5-5',
    'claude-opus-4-7',
    'claude-opus-4-8-20260401',
    'claude-mythos-preview',
  ]) {
    const prepared = provider.prepare({ ...request, model }, { anthropic_version: '2023-06-01' });
    assert.equal(prepared.temperature, undefined, model);
    assert.equal(prepared.top_p, undefined, model);
  }
  for (const model of ['test', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-6']) {
    assert.equal(provider.prepare({ ...request, model }, {}).temperature, 0.2);
    const prepared = provider.prepare({ ...request, model }, { anthropic_version: '2026-10-21' });
    assert.equal(prepared.temperature, undefined);
    assert.equal(prepared.top_p, undefined);
  }
  assert.equal(
    providerFor({ provider: 'openai' }).prepare({ ...request, model: 'claude-haiku-5-5' }).temperature,
    0.2,
  );
});
