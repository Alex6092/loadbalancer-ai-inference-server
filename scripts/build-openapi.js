import fs from 'node:fs';

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const jsonBody = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const response = (description, schema) => ({
  description,
  ...(schema ? { content: { 'application/json': { schema } } } : {}),
});
const errorResponses = Object.fromEntries(
  [400, 401, 403, 404, 409, 429, 503].map((code) => [
    code,
    response('Erreur explicite du service', ref('Error')),
  ]),
);
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const user = {
  name: 'X-End-User-ID',
  in: 'header',
  description: 'Identifiant opaque propre à l’application ; obligatoire si sa politique le demande.',
  schema: { type: 'string', maxLength: 200 },
};
const completion = {
  type: 'object',
  required: ['model', 'messages'],
  additionalProperties: true,
  properties: {
    model: {
      type: 'string',
      description: 'Identifiant exact déclaré dans le catalogue et servi par le worker.',
    },
    messages: {
      type: 'array',
      minItems: 1,
      maxItems: 1000,
      items: {
        type: 'object',
        required: ['role'],
        additionalProperties: true,
        properties: {
          role: { enum: ['system', 'developer', 'user', 'assistant', 'tool', 'function'] },
          content: {
            oneOf: [
              { type: 'string' },
              { type: 'null' },
              {
                type: 'array',
                items: {
                  oneOf: [
                    {
                      type: 'object',
                      required: ['type', 'text'],
                      properties: { type: { const: 'text' }, text: { type: 'string' } },
                    },
                    {
                      type: 'object',
                      required: ['type', 'image_url'],
                      properties: {
                        type: { const: 'image_url' },
                        image_url: {
                          type: 'object',
                          required: ['url'],
                          properties: { url: { type: 'string' }, detail: { enum: ['auto', 'low', 'high'] } },
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
    max_tokens: {
      type: 'integer',
      minimum: 1,
      description: 'Exclusif avec max_completion_tokens ; sortie par défaut définie par le modèle.',
    },
    max_completion_tokens: { type: 'integer', minimum: 1 },
    n: { const: 1 },
    stream: { type: 'boolean', default: false },
    temperature: { type: 'number' },
    top_p: { type: 'number' },
    tools: { type: 'array', items: { type: 'object' } },
    tool_choice: {},
    response_format: { type: 'object' },
    stream_options: { type: 'object' },
  },
};
const paths = {
  '/v1/jobs': {
    post: {
      tags: ['Jobs'],
      summary: 'Soumettre un traitement asynchrone',
      parameters: [
        user,
        {
          name: 'Idempotency-Key',
          in: 'header',
          description:
            'Réutiliser la même valeur et le même payload en cas de doute sur la réception. Périmètre : clé d’API.',
          schema: { type: 'string', maxLength: 200 },
        },
      ],
      requestBody: jsonBody(ref('AsyncRequest')),
      responses: {
        202: response('Accepté durablement', ref('Job')),
        200: response('Soumission déjà enregistrée', ref('Job')),
        ...errorResponses,
      },
    },
  },
  '/v1/jobs/{id}': {
    get: {
      tags: ['Jobs'],
      summary: 'État, estimation d’attente et résultat',
      parameters: [id],
      responses: { 200: response('Job de l’application appelante', ref('Job')), ...errorResponses },
    },
  },
  '/v1/jobs/{id}/cancel': {
    post: {
      tags: ['Jobs'],
      summary: 'Annuler le job et tenter d’interrompre le calcul distant',
      parameters: [id],
      responses: { 200: response('État après annulation', ref('Job')), ...errorResponses },
    },
  },
  '/v1/chat/completions': {
    post: {
      tags: ['Chat'],
      summary: 'Chat synchrone ou streaming OpenAI avec mise en file',
      description:
        'X-Job-ID est envoyé immédiatement en streaming. Commentaires SSE pendant l’attente ; fragments Chat Completions puis [DONE]. Les erreurs après ouverture du flux sont des événements data contenant error. Une déconnexion annule le job. Pas de reprise après exposition du premier fragment.',
      parameters: [user],
      requestBody: jsonBody(ref('ChatRequest')),
      responses: {
        200: {
          description: 'Réponse OpenAI ou flux SSE',
          headers: {
            'X-Job-ID': { description: 'Job à consulter via GET /v1/jobs/{id}', schema: { type: 'string' } },
          },
          content: {
            'application/json': { schema: { type: 'object', additionalProperties: true } },
            'text/event-stream': { schema: { type: 'string' } },
          },
        },
        502: response('Échec de génération synchrone', ref('Error')),
        504: response('Attente synchrone expirée', ref('Error')),
        ...errorResponses,
      },
    },
  },
  '/v1/models': {
    get: {
      tags: ['Catalogue'],
      summary: 'Modèles autorisés',
      responses: {
        200: response('Catalogue filtré', {
          type: 'object',
          properties: { object: { const: 'list' }, data: { type: 'array', items: ref('Model') } },
        }),
        ...errorResponses,
      },
    },
  },
  '/v1/workers/status': {
    get: {
      tags: ['Catalogue'],
      summary: 'Disponibilité et capacité agrégées par modèle',
      responses: {
        200: response('Aucun secret ni URL interne', {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  model: { type: 'string' },
                  workers: { type: 'integer' },
                  available_workers: { type: 'integer' },
                  capacity: { type: 'integer' },
                  occupied: { type: 'integer' },
                },
              },
            },
            calculated_at: { type: 'string', format: 'date-time' },
          },
        }),
        ...errorResponses,
      },
    },
  },
  '/v1/usage': {
    get: {
      tags: ['Quotas'],
      summary: 'Consommation de l’application et quotas applicables',
      parameters: [
        user,
        ...['since', 'until', 'group', 'key_id', 'user_id'].map((name) => ({
          name,
          in: 'query',
          schema:
            name === 'group' ? { enum: ['application', 'key', 'user', 'model', 'day'] } : { type: 'string' },
          description:
            name === 'since' || name === 'until'
              ? 'Date ISO ; historique statistique de 365 jours par défaut.'
              : undefined,
        })),
      ],
      responses: {
        200: response('Statistiques et budgets', { type: 'object', additionalProperties: true }),
        ...errorResponses,
      },
    },
  },
  '/health/live': {
    get: {
      tags: ['Exploitation'],
      security: [],
      summary: 'Processus vivant',
      responses: { 200: response('OK') },
    },
  },
  '/health/ready': {
    get: {
      tags: ['Exploitation'],
      security: [],
      summary: 'Service et base accessibles ; ne garantit pas un worker disponible',
      responses: { 200: response('OK') },
    },
  },
};
const schemas = {
  ChatRequest: completion,
  AsyncRequest: {
    ...completion,
    properties: {
      ...completion.properties,
      stream: { const: false },
      callbackURL: {
        type: 'string',
        format: 'uri',
        description: 'Destination appartenant aux URL de base autorisées de l’application. Facultative.',
      },
    },
  },
  Error: {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          details: { type: 'object', additionalProperties: true },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  Usage: {
    type: 'object',
    required: ['prompt_tokens', 'completion_tokens', 'total_tokens', 'estimated'],
    properties: {
      prompt_tokens: { type: 'integer', minimum: 0 },
      completion_tokens: { type: 'integer', minimum: 0 },
      total_tokens: { type: 'integer', minimum: 0 },
      estimated: { type: 'boolean' },
    },
  },
  Job: {
    type: 'object',
    required: ['id', 'object', 'status', 'mode', 'model', 'usage', 'links'],
    properties: {
      id: { type: 'string' },
      object: { const: 'job' },
      status: { enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired'] },
      mode: { enum: ['chat', 'async'] },
      model: { type: 'string' },
      attempts: { type: 'integer' },
      created_at: { type: 'string', format: 'date-time' },
      started_at: { type: ['string', 'null'], format: 'date-time' },
      finished_at: { type: ['string', 'null'], format: 'date-time' },
      expires_at: { type: 'string', format: 'date-time' },
      queue: {
        oneOf: [
          { type: 'null' },
          {
            type: 'object',
            required: ['estimated_jobs_ahead', 'running_for_model', 'reason', 'calculated_at', 'estimate'],
            properties: {
              estimated_jobs_ahead: { type: ['integer', 'null'], minimum: 0 },
              running_for_model: { type: 'integer' },
              reason: { enum: ['capacity', 'workers_unavailable', 'retry_backoff'] },
              calculated_at: { type: 'string', format: 'date-time' },
              estimate: { const: true },
            },
          },
        ],
      },
      result: {},
      error: {},
      usage: ref('Usage'),
      content_expired: { type: 'boolean' },
      reused: { type: 'boolean' },
      links: {
        type: 'object',
        required: ['self', 'cancel'],
        properties: { self: { type: 'string' }, cancel: { type: 'string' } },
      },
    },
  },
  Model: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      object: { const: 'model' },
      owned_by: { type: 'string' },
      vision: { type: 'boolean' },
      context_tokens: { type: 'integer' },
      max_output_tokens: { type: 'integer' },
    },
  },
  Policy: {
    type: 'object',
    properties: {
      count: { enum: ['input', 'output', 'both'], default: 'both' },
      credit: {
        type: 'object',
        properties: { enabled: { type: 'boolean', default: false }, tokens: { type: 'integer', minimum: 0 } },
      },
      windows: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          required: ['hours', 'tokens'],
          properties: {
            hours: { type: 'number', exclusiveMinimum: 0, maximum: 87600 },
            tokens: { type: 'integer', minimum: 0 },
            enabled: { type: 'boolean', default: true },
          },
        },
      },
    },
  },
  CallbackEvent: {
    type: 'object',
    required: ['id', 'type', 'created_at', 'job_id', 'status', 'result', 'error'],
    properties: {
      id: { type: 'string', description: 'Identifiant stable à dédupliquer transactionnellement.' },
      type: { enum: ['job.succeeded', 'job.failed', 'job.cancelled', 'job.expired'] },
      created_at: { type: 'string', format: 'date-time' },
      job_id: { type: 'string' },
      status: { enum: ['succeeded', 'failed', 'cancelled', 'expired'] },
      result: {},
      error: {},
    },
  },
};
const specification = {
  openapi: '3.1.0',
  info: {
    title: 'La Providence — Ordonnanceur IA',
    version: '1.0.0',
    description:
      'Authentification serveur à serveur. Les callbacks sont signés HMAC-SHA256(timestamp + "." + corps brut). Voir docs/API.md pour les règles de livraison et d’administration.',
  },
  servers: [{ url: 'http://127.0.0.1:3000', description: 'Développement local' }],
  security: [{ bearer: [] }],
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, schemas },
  paths,
  webhooks: {
    jobCompleted: {
      post: {
        summary: 'Callback HTTP vers callbackURL',
        security: [],
        parameters: [
          { name: 'X-Event-ID', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'X-Callback-Timestamp', in: 'header', required: true, schema: { type: 'string' } },
          {
            name: 'X-Callback-Signature',
            in: 'header',
            required: true,
            schema: { type: 'string' },
            description: 'sha256=<HMAC hexadécimal>',
          },
        ],
        requestBody: jsonBody(ref('CallbackEvent')),
        responses: { '2XX': response('Événement enregistré ou déjà traité') },
      },
    },
  },
};
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/openapi.json', JSON.stringify(specification, null, 2) + '\n');
console.log('docs/openapi.json généré.');
