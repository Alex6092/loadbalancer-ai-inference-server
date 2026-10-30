import fs from 'node:fs';
import path from 'node:path';
import { createServer } from './server.js';

// A directory lock prevents two schedulers from using the same file. A stale lock
// requires verifying the recorded PID before removal; never silently steal it.
const filename = path.resolve(process.env.DATABASE_PATH || './data/service.sqlite');
fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
const lock = `${filename}.lock`;
try {
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('PID de verrou invalide.');
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (check) {
      if (check.code === 'ESRCH') alive = false;
      else throw check;
    }
    if (alive) throw new Error('Une autre instance est active.');
    fs.unlinkSync(path.join(lock, 'pid'));
    fs.rmdirSync(lock);
    fs.mkdirSync(lock, { mode: 0o700 });
  }
} catch {
  console.error(`Verrou actif ou non vérifiable : ${lock}. Vérifier le processus avant de le retirer.`);
  process.exit(1);
}
fs.writeFileSync(path.join(lock, 'pid'), String(process.pid), { mode: 0o600 });
let app;
const release = () => {
  try {
    fs.unlinkSync(path.join(lock, 'pid'));
    fs.rmdirSync(lock);
  } catch {
    /* never recursively delete an unexpected path */
  }
};
try {
  app = await createServer();
  await app.listen({ host: app.context.config.host, port: app.context.config.port });
  const shutdown = async () => {
    await app.close();
    release();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  console.error(error.message);
  if (app) await app.close();
  release();
  process.exitCode = 1;
}
