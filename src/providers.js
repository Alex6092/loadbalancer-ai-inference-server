import { ApiError, parse } from './security.js';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const unsupported = (field, reason = 'sans équivalent Anthropic') =>
  new ApiError(400, 'unsupported_worker_parameter', `Paramètre ${field} : ${reason}.`, {
    provider: 'anthropic',
    field,
  });
function fields(value, allowed, path) {
  if (!object(value)) throw unsupported(path, 'objet attendu');
  for (const key of Object.keys(value))
    if (value[key] != null && !allowed.includes(key)) throw unsupported(`${path}.${key}`);
}
function text(value, path) {
  if (typeof value !== 'string' || !value.length) throw unsupported(path, 'chaîne non vide attendue');
  return value;
}
function blocks(content, path) {
  if (content == null || content === '') return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) throw unsupported(path, 'texte ou liste attendus');
  return content.flatMap((part, index) => {
    const at = `${path}[${index}]`;
    if (part?.type === 'text') {
      fields(part, ['type', 'text'], at);
      if (typeof part.text !== 'string') throw unsupported(at, 'texte attendu');
      return part.text ? [{ type: 'text', text: part.text }] : [];
    }
    if (part?.type !== 'image_url') throw unsupported(at);
    fields(part, ['type', 'image_url'], at);
    fields(part.image_url, ['url', 'detail'], `${at}.image_url`);
    if (part.image_url.detail != null && part.image_url.detail !== 'auto')
      throw unsupported(`${at}.image_url.detail`);
    const url = text(part.image_url.url, `${at}.image_url.url`);
    const data = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url);
    if (data)
      return [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: `image/${data[1] === 'jpg' ? 'jpeg' : data[1]}`,
            data: data[2].replace(/[\r\n]/g, ''),
          },
        },
      ];
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw unsupported(`${at}.image_url.url`, 'URL invalide');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      throw unsupported(`${at}.image_url.url`, 'URL HTTP(S) attendue');
    return [{ type: 'image', source: { type: 'url', url } }];
  });
}

function acceptsSampling(request, worker) {
  if ((worker.anthropic_version || '2023-06-01') >= '2026-10-21') return false;
  if (request.model === 'claude-mythos-preview') return false;
  const version = /^claude-(?:haiku|sonnet|opus|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(
    request.model,
  );
  return !version || !(Number(version[1]) > 4 || (Number(version[1]) === 4 && Number(version[2]) >= 7));
}

// Anthropic rejects numerical bounds, but accepts numeric enum values. Translate
// small bounded integer domains exactly; never weaken an unsupported constraint.
function anthropicSchema(schema) {
  if (!object(schema)) return schema;
  const result = { ...schema };
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
    if (object(schema[key]))
      result[key] = Object.fromEntries(
        Object.entries(schema[key]).map(([name, child]) => [name, anthropicSchema(child)]),
      );
  }
  for (const key of [
    'items',
    'additionalItems',
    'additionalProperties',
    'unevaluatedProperties',
    'unevaluatedItems',
    'contains',
    'propertyNames',
    'not',
    'if',
    'then',
    'else',
  ]) {
    if (object(schema[key])) result[key] = anthropicSchema(schema[key]);
    else if (Array.isArray(schema[key])) result[key] = schema[key].map(anthropicSchema);
  }
  for (const key of ['anyOf', 'allOf', 'oneOf', 'prefixItems'])
    if (Array.isArray(schema[key])) result[key] = schema[key].map(anthropicSchema);
  if (object(schema.dependencies))
    result.dependencies = Object.fromEntries(
      Object.entries(schema.dependencies).map(([name, child]) => [
        name,
        object(child) ? anthropicSchema(child) : child,
      ]),
    );
  const { minimum, maximum } = schema;
  if (
    schema.type === 'integer' &&
    Number.isSafeInteger(minimum) &&
    Number.isSafeInteger(maximum) &&
    maximum >= minimum &&
    maximum - minimum < 256 &&
    (schema.enum === undefined || Array.isArray(schema.enum))
  ) {
    const values = Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index);
    const allowed =
      schema.enum === undefined ? values : values.filter((value) => schema.enum.includes(value));
    // Leave impossible schemas intact for the backend to reject rather than
    // replacing them with an invalid empty enum or broadening the accepted set.
    if (allowed.length) {
      result.enum = allowed;
      delete result.minimum;
      delete result.maximum;
    }
  }
  return result;
}

function anthropicRequest(request, worker) {
  if (!object(request)) throw unsupported('request', 'objet attendu');
  // Build the native payload explicitly below. Extra top-level options from other
  // backends (enable_thinking, seed, extra_body, etc.) are intentionally ignored.
  // Keep the original request intact for persistence, idempotency and OpenAI routing.
  if (request.n != null && request.n !== 1) throw unsupported('n');
  if (request.stream_options != null) {
    fields(request.stream_options, ['include_usage'], 'stream_options');
    if (
      request.stream_options.include_usage != null &&
      typeof request.stream_options.include_usage !== 'boolean'
    )
      throw unsupported('stream_options.include_usage');
  }
  const result = {
    model: request.model,
    max_tokens: request.max_completion_tokens ?? request.max_tokens,
    stream: Boolean(request.stream),
    messages: [],
  };
  for (const key of ['temperature', 'top_p']) {
    if (request[key] == null) continue;
    if (!acceptsSampling(request, worker)) continue;
    if (typeof request[key] !== 'number' || request[key] < 0 || request[key] > 1)
      throw unsupported(key, 'nombre entre 0 et 1 attendu');
    result[key] = request[key];
  }
  if (request.stop != null) {
    const stops = typeof request.stop === 'string' ? [request.stop] : request.stop;
    if (!Array.isArray(stops) || !stops.every((s) => typeof s === 'string' && s.length))
      throw unsupported('stop', 'chaîne ou liste de chaînes non vides attendue');
    result.stop_sequences = stops;
  }
  if (request.user != null) result.metadata = { user_id: text(request.user, 'user') };
  if (request.tools != null && request.functions != null)
    throw unsupported('functions', 'exclusif avec tools');
  if (request.tool_choice != null && request.function_call != null)
    throw unsupported('function_call', 'exclusif avec tool_choice');
  const legacy = request.functions != null;
  const definitions = request.tools ?? request.functions;
  if (definitions != null) {
    if (!Array.isArray(definitions)) throw unsupported('tools', 'liste attendue');
    result.tools = definitions.map((entry, i) => {
      if (!legacy) {
        fields(entry, ['type', 'function'], `tools[${i}]`);
        if (entry.type !== 'function') throw unsupported(`tools[${i}].type`);
      }
      const fn = legacy ? entry : entry.function;
      fields(fn, ['name', 'description', 'parameters', 'strict'], `tools[${i}].function`);
      if (fn.parameters != null && !object(fn.parameters)) throw unsupported(`tools[${i}].parameters`);
      if (fn.strict != null && typeof fn.strict !== 'boolean') throw unsupported(`tools[${i}].strict`);
      return {
        name: text(fn.name, `tools[${i}].name`),
        ...(fn.description == null ? {} : { description: fn.description }),
        input_schema: anthropicSchema(
          fn.parameters ?? { type: 'object', properties: {}, additionalProperties: false },
        ),
        ...(fn.strict == null ? {} : { strict: fn.strict }),
      };
    });
    if (new Set(result.tools.map((tool) => tool.name)).size !== result.tools.length)
      throw unsupported('tools', 'noms dupliqués');
  }
  const choice = request.tool_choice ?? request.function_call;
  if (choice != null) {
    if (['auto', 'none', 'required'].includes(choice))
      result.tool_choice = { type: choice === 'required' ? 'any' : choice };
    else if (object(choice)) {
      if (legacy) fields(choice, ['name'], 'function_call');
      else {
        fields(choice, ['type', 'function'], 'tool_choice');
        if (choice.type !== 'function') throw unsupported('tool_choice.type');
        fields(choice.function, ['name'], 'tool_choice.function');
      }
      const name = text(legacy ? choice.name : choice.function.name, 'tool_choice.name');
      if (!result.tools?.some((tool) => tool.name === name))
        throw unsupported('tool_choice', 'outil inconnu');
      result.tool_choice = { type: 'tool', name };
    } else throw unsupported('tool_choice');
    if (!result.tools?.length && result.tool_choice.type !== 'none')
      throw unsupported('tool_choice', 'outils requis');
  }
  if (request.parallel_tool_calls != null && typeof request.parallel_tool_calls !== 'boolean')
    throw unsupported('parallel_tool_calls', 'booléen attendu');
  if (legacy || request.parallel_tool_calls != null) {
    result.tool_choice ||= { type: 'auto' };
    if (result.tool_choice.type !== 'none')
      result.tool_choice.disable_parallel_tool_use = legacy || !request.parallel_tool_calls;
  }
  if (request.response_format != null) {
    const format = request.response_format;
    fields(format, ['type', 'json_schema'], 'response_format');
    if (format.type === 'json_schema') {
      fields(format.json_schema, ['name', 'description', 'schema', 'strict'], 'response_format.json_schema');
      if (!object(format.json_schema.schema)) throw unsupported('response_format.json_schema.schema');
      result.output_config = {
        format: { type: 'json_schema', schema: anthropicSchema(format.json_schema.schema) },
      };
    } else if (format.type !== 'text')
      throw unsupported('response_format.type', 'utiliser json_schema avec un schéma explicite, ou text');
  }
  if (!Array.isArray(request.messages) || !request.messages.length) throw unsupported('messages');
  const system = [];
  const pending = new Map();
  const seenIds = new Set();
  function append(role, content) {
    if (!content.length) throw unsupported('messages.content', 'message vide');
    const last = result.messages.at(-1);
    if (last?.role === role) last.content.push(...content);
    else result.messages.push({ role, content });
  }
  for (const [index, message] of request.messages.entries()) {
    const at = `messages[${index}]`;
    fields(message, ['role', 'content', 'tool_calls', 'tool_call_id', 'function_call', 'name'], at);
    const content = blocks(message.content, `${at}.content`);
    if (['system', 'developer'].includes(message.role)) {
      if (content.some((part) => part.type !== 'text'))
        throw unsupported(`${at}.content`, 'texte système requis');
      if (
        message.name != null ||
        message.tool_calls != null ||
        message.function_call != null ||
        message.tool_call_id != null
      )
        throw unsupported(at);
      system.push(...content);
      continue;
    }
    if (['tool', 'function'].includes(message.role)) {
      if (message.tool_calls != null || message.function_call != null) throw unsupported(at);
      let id = message.tool_call_id;
      if (message.role === 'function') {
        const matches = [...pending].filter(([, name]) => name === message.name);
        if (matches.length !== 1) throw unsupported(`${at}.name`, 'résultat de fonction ambigu');
        id = matches[0][0];
      }
      if (!pending.has(id)) throw unsupported(`${at}.tool_call_id`, 'appel d’outil correspondant absent');
      pending.delete(id);
      append('user', [{ type: 'tool_result', tool_use_id: id, content }]);
      continue;
    }
    if (!['user', 'assistant'].includes(message.role)) throw unsupported(`${at}.role`);
    if (pending.size) throw unsupported(at, 'résultats des appels d’outils précédents requis');
    if (message.name != null || message.tool_call_id != null) throw unsupported(at);
    if (message.tool_calls != null && message.function_call != null)
      throw unsupported(at, 'deux formats d’outils mélangés');
    let calls = message.tool_calls;
    if (message.function_call != null)
      calls = [{ id: `legacy_${index}`, type: 'function', function: message.function_call }];
    if (calls != null) {
      if (message.role !== 'assistant' || !Array.isArray(calls)) throw unsupported(`${at}.tool_calls`);
      for (const call of calls) {
        fields(call, ['id', 'type', 'function'], `${at}.tool_calls`);
        if (call.type !== 'function') throw unsupported(`${at}.tool_calls.type`);
        fields(call.function, ['name', 'arguments'], `${at}.tool_calls.function`);
        const id = text(call.id, `${at}.tool_calls.id`);
        const name = text(call.function.name, `${at}.tool_calls.name`);
        let input;
        try {
          input = JSON.parse(call.function.arguments);
        } catch {
          throw unsupported(`${at}.tool_calls.arguments`, 'objet JSON valide requis');
        }
        if (!object(input) || seenIds.has(id))
          throw unsupported(`${at}.tool_calls`, 'arguments invalides ou identifiant dupliqué');
        seenIds.add(id);
        pending.set(id, name);
        content.push({ type: 'tool_use', id, name, input });
      }
    }
    append(message.role, content);
  }
  if (pending.size) throw unsupported('messages', 'résultats des derniers appels d’outils requis');
  if (!result.messages.length) throw unsupported('messages', 'au moins un message user ou assistant requis');
  if (system.length) result.system = system;
  return result;
}

function anthropicUsage(usage) {
  if (!object(usage)) return undefined;
  const values = [
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_creation_input_tokens ?? 0,
    usage.cache_read_input_tokens ?? 0,
  ];
  if (!values.every((n) => Number.isSafeInteger(n) && n >= 0)) return undefined;
  const prompt_tokens = values[0] + values[2] + values[3];
  const total_tokens = prompt_tokens + values[1];
  if (!Number.isSafeInteger(total_tokens)) return undefined;
  return { prompt_tokens, completion_tokens: values[1], total_tokens };
}
function finishReason(reason, legacy) {
  if (['end_turn', 'stop_sequence'].includes(reason)) return 'stop';
  if (['max_tokens', 'model_context_window_exceeded'].includes(reason)) return 'length';
  if (reason === 'tool_use') return legacy ? 'function_call' : 'tool_calls';
  if (reason === 'refusal') return 'content_filter';
  throw new Error('Motif de fin Anthropic non pris en charge.');
}
function envelope(message, request, stream = false) {
  if (typeof message.id !== 'string') throw new Error('Identifiant Anthropic manquant.');
  return {
    id: message.id,
    object: stream ? 'chat.completion.chunk' : 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: request.model,
  };
}
function anthropicResponse(body, request) {
  if (body?.type !== 'message' || body.role !== 'assistant' || !Array.isArray(body.content))
    throw new Error('Réponse Anthropic invalide.');
  const legacy = request.functions != null;
  const message = { role: 'assistant', content: '' };
  for (const block of body.content) {
    if (block.type === 'text' && typeof block.text === 'string') message.content += block.text;
    else if (
      block.type === 'tool_use' &&
      typeof block.id === 'string' &&
      typeof block.name === 'string' &&
      object(block.input)
    ) {
      message.tool_calls ||= [];
      message.tool_calls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
    } else if (!['thinking', 'redacted_thinking'].includes(block.type))
      throw new Error('Bloc Anthropic invalide.');
  }
  if (legacy && message.tool_calls) {
    if (message.tool_calls.length !== 1) throw new Error('Appels de fonctions ambigus.');
    message.function_call = message.tool_calls[0].function;
    delete message.tool_calls;
  }
  return {
    ...envelope(body, request),
    choices: [{ index: 0, message, finish_reason: finishReason(body.stop_reason, legacy) }],
    usage: anthropicUsage(body.usage),
  };
}

// Parse SSE incrementally, including CRLF or UTF-8 split across network reads.
async function* sse(response, limit) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '',
    size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Flux trop volumineux.');
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) yield data;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
async function* openaiStream(response, request, limit) {
  for await (const data of sse(response, limit)) {
    if (data === '[DONE]') return;
    const chunk = JSON.parse(data);
    if (chunk.error || !Array.isArray(chunk.choices)) throw new Error('Fragment SSE invalide.');
    yield chunk;
  }
  throw new Error('Flux interrompu avant [DONE].');
}
async function* anthropicStream(response, request, limit) {
  let base,
    reason,
    usage = {};
  let finalOutputUsage = false;
  const blocks = new Map();
  let toolCount = 0;
  const legacy = request.functions != null;
  const chunk = (delta, finish_reason = null) => ({ ...base, choices: [{ index: 0, delta, finish_reason }] });
  for await (const data of sse(response, limit)) {
    const event = JSON.parse(data);
    if (event.type === 'error') throw new Error('Erreur dans le flux Anthropic.');
    if (event.type === 'ping') continue;
    if (event.type === 'message_start') {
      if (base || event.message?.type !== 'message' || event.message.role !== 'assistant')
        throw new Error('Début de flux invalide.');
      base = envelope(event.message, request, true);
      usage = { ...event.message.usage };
      yield chunk({ role: 'assistant', content: '' });
    } else if (event.type === 'content_block_start') {
      if (!base || reason || !Number.isSafeInteger(event.index) || event.index < 0 || blocks.has(event.index))
        throw new Error('Bloc SSE invalide.');
      const block = { ...event.content_block, open: true };
      blocks.set(event.index, block);
      if (block.type === 'text') {
        if (typeof block.text !== 'string') throw new Error('Texte SSE invalide.');
        if (block.text) yield chunk({ content: block.text });
      } else if (block.type === 'tool_use') {
        if (typeof block.id !== 'string' || typeof block.name !== 'string' || !object(block.input))
          throw new Error('Outil SSE invalide.');
        block.toolIndex = toolCount++;
        if (legacy && toolCount > 1) throw new Error('Appels de fonctions ambigus.');
        block.arguments = Object.keys(block.input).length ? JSON.stringify(block.input) : '';
        const fn = { name: block.name, arguments: block.arguments };
        yield chunk(
          legacy
            ? { function_call: fn }
            : { tool_calls: [{ index: block.toolIndex, id: block.id, type: 'function', function: fn }] },
        );
      } else if (!['thinking', 'redacted_thinking'].includes(block.type))
        throw new Error('Bloc Anthropic non pris en charge.');
    } else if (event.type === 'content_block_delta') {
      const block = blocks.get(event.index);
      if (!block?.open) throw new Error('Delta sans bloc actif.');
      if (event.delta?.type === 'text_delta' && block.type === 'text' && typeof event.delta.text === 'string')
        yield chunk({ content: event.delta.text });
      else if (
        event.delta?.type === 'input_json_delta' &&
        block.type === 'tool_use' &&
        typeof event.delta.partial_json === 'string'
      ) {
        block.arguments += event.delta.partial_json;
        const fn = { arguments: event.delta.partial_json };
        yield chunk(
          legacy ? { function_call: fn } : { tool_calls: [{ index: block.toolIndex, function: fn }] },
        );
      } else if (!(
        ['thinking_delta', 'signature_delta'].includes(event.delta?.type) && block.type === 'thinking'
      ))
        throw new Error('Delta Anthropic invalide.');
    } else if (event.type === 'content_block_stop') {
      const block = blocks.get(event.index);
      if (!block?.open) throw new Error('Fin de bloc invalide.');
      block.open = false;
      if (block.type === 'tool_use') {
        if (!block.arguments) {
          block.arguments = '{}';
          const fn = { arguments: '{}' };
          yield chunk(
            legacy ? { function_call: fn } : { tool_calls: [{ index: block.toolIndex, function: fn }] },
          );
        }
        if (!object(JSON.parse(block.arguments))) throw new Error('Arguments d’outil invalides.');
      }
    } else if (event.type === 'message_delta') {
      if (!base || [...blocks.values()].some((b) => b.open)) throw new Error('Fin de message prématurée.');
      // These counters are cumulative, never add consecutive message_delta values.
      usage = { ...usage, ...event.usage };
      if (event.usage && Object.hasOwn(event.usage, 'output_tokens')) finalOutputUsage = true;
      if (event.delta?.stop_reason != null) reason = finishReason(event.delta.stop_reason, legacy);
    } else if (event.type === 'message_stop') {
      if (!base || !reason || [...blocks.values()].some((b) => b.open))
        throw new Error('Fin de flux invalide.');
      yield chunk({}, reason);
      const normalized = finalOutputUsage ? anthropicUsage(usage) : undefined;
      if (normalized) yield { ...base, choices: [], usage: normalized };
      return;
    }
    // Future non-content event types may be added by Anthropic.
  }
  throw new Error('Flux interrompu avant message_stop.');
}

const openai = {
  headers: (_worker, secret) => ({ ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }),
  prepare: (request) => ({
    ...request,
    ...(request.stream
      ? {
          stream_options: { ...request.stream_options, include_usage: true },
        }
      : {}),
  }),
  path: '/chat/completions',
  response: (body) => body,
  stream: openaiStream,
  async probe(worker, get) {
    const body = await get('/models');
    if (!Array.isArray(body.data) || !parse(worker.models).every((id) => body.data.some((m) => m.id === id)))
      throw new Error('Catalogue des modèles incomplet.');
  },
};
const anthropic = {
  headers: (worker, secret) => ({
    ...(secret ? { 'x-api-key': secret } : {}),
    'anthropic-version': worker.anthropic_version || '2023-06-01',
    ...(worker.anthropic_workspace_id ? { 'anthropic-workspace-id': worker.anthropic_workspace_id } : {}),
  }),
  prepare: anthropicRequest,
  path: '/messages',
  response: anthropicResponse,
  stream: anthropicStream,
  async probe(worker, get) {
    const missing = new Set(parse(worker.models));
    const cursors = new Set();
    let path = '/models';
    for (let page = 0; ; page++) {
      if (page >= 100) throw new Error('Catalogue trop volumineux.');
      const body = await get(path);
      if (!Array.isArray(body.data)) throw new Error('Catalogue invalide.');
      for (const model of body.data) missing.delete(model.id);
      if (!missing.size || !body.has_more) break;
      if (typeof body.last_id !== 'string' || !body.last_id || cursors.has(body.last_id))
        throw new Error('Pagination invalide.');
      cursors.add(body.last_id);
      path = `/models?after_id=${encodeURIComponent(body.last_id)}`;
    }
    for (const id of missing) {
      const model = await get(`/models/${encodeURIComponent(id)}`);
      if (model.type !== 'model' || typeof model.id !== 'string' || !model.id)
        throw new Error('Modèle absent.');
    }
  },
};
export function providerFor(worker) {
  if (worker.provider == null || worker.provider === 'openai') return openai;
  if (worker.provider === 'anthropic') return anthropic;
  throw new ApiError(400, 'invalid_provider', 'Protocole de worker inconnu.');
}
export function compatibilityError(worker, request) {
  try {
    providerFor(worker).prepare(request, worker);
    return null;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
}
