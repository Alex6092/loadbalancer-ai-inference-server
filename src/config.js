import path from 'node:path';

export function configuration(overrides = {}) {
  const config = {
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 3000),
    database: process.env.DATABASE_PATH || './data/service.sqlite',
    encryptionKey: process.env.ENCRYPTION_KEY,
    secureCookies: process.env.SECURE_COOKIES !== 'false',
    trustProxy: process.env.TRUST_PROXY ? process.env.TRUST_PROXY.split(',').map((v) => v.trim()) : false,
    retentionDays: Number(process.env.RETENTION_DAYS || 7),
    statisticsDays: Number(process.env.STATISTICS_DAYS || 365),
    asyncWaitMs: Number(process.env.ASYNC_WAIT_SECONDS || 86400) * 1000,
    chatWaitMs: Number(process.env.CHAT_WAIT_SECONDS || 600) * 1000,
    attemptTimeoutMs: Number(process.env.ATTEMPT_TIMEOUT_SECONDS || 1800) * 1000,
    probeIntervalMs: Number(process.env.PROBE_INTERVAL_SECONDS || 15) * 1000,
    probeTimeoutMs: 5000,
    heartbeatMs: 15000,
    maxQueued: Number(process.env.MAX_QUEUED || 2000),
    maxQueuedPerApp: Number(process.env.MAX_QUEUED_PER_APP || 500),
    maxAttempts: 3,
    callbackWindowMs: 86400000,
    callbackTimeoutMs: 10000,
    tickMs: 250,
    bodyLimit: 16 * 1024 * 1024,
    logger: true,
    release: process.env.RELEASE_SHA || 'development',
    ...overrides,
  };
  if (!config.encryptionKey || Buffer.from(config.encryptionKey, 'base64').length !== 32) {
    throw new Error(
      'ENCRYPTION_KEY doit contenir une clé de 32 octets encodée en base64. Exécuter npm run init.',
    );
  }
  for (const name of [
    'port',
    'retentionDays',
    'statisticsDays',
    'asyncWaitMs',
    'chatWaitMs',
    'attemptTimeoutMs',
    'probeIntervalMs',
    'maxQueued',
    'maxQueuedPerApp',
  ]) {
    if (!Number.isFinite(config[name]) || config[name] <= 0)
      throw new Error(`Configuration invalide : ${name}`);
  }
  config.database = config.database === ':memory:' ? config.database : path.resolve(config.database);
  return config;
}
