import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fixture, until } from './helpers.js';
import { openDatabase } from '../src/db.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Outils CLI : initialisation sans écrasement, compte par stdin et sauvegarde restaurable', async (t) => {
  const f = await fixture(t);
  await f.app.close();
  const env = { ...process.env, ENCRYPTION_KEY: f.config.encryptionKey, DATABASE_PATH: f.config.database };
  const run = (script, args = [], input) =>
    spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
      cwd: f.directory,
      env,
      input,
      encoding: 'utf8',
      timeout: 10000,
    });
  let result = run('init.js');
  assert.equal(result.status, 0, result.stderr);
  const first = fs.readFileSync(path.join(f.directory, '.env'), 'utf8');
  result = run('init.js');
  assert.equal(result.status, 0);
  assert.equal(fs.readFileSync(path.join(f.directory, '.env'), 'utf8'), first);
  result = run('create-admin.js', ['operateur'], 'mot-de-passe-cli-123\n');
  assert.equal(result.status, 0, result.stderr);
  result = run('backup.js');
  assert.equal(result.status, 0, result.stderr);
  const backups = fs.readdirSync(path.join(f.directory, 'backups'));
  assert.equal(backups.length, 1);
  const restored = openDatabase(path.join(f.directory, 'backups', backups[0]));
  try {
    assert.equal(restored.prepare('SELECT username FROM admins').get().username, 'operateur');
    assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    restored.close();
  }
});

test('Exécutable : verrou d’instance unique et reprise automatique d’un verrou après crash', async (t) => {
  const f = await fixture(t);
  await f.app.close();
  const reserve = http.createServer();
  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const env = {
    ...process.env,
    DATABASE_PATH: f.config.database,
    ENCRYPTION_KEY: f.config.encryptionKey,
    HOST: '127.0.0.1',
    PORT: String(port),
    SECURE_COOKIES: 'false',
  };
  let child;
  const start = () => {
    child = spawn(process.execPath, [path.join(root, 'src/index.js')], {
      cwd: f.directory,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.resume();
    child.stderr.resume();
  };
  const ready = () =>
    until(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(200) }))
          .ok;
      } catch {
        return false;
      }
    }, 10000);
  const kill = async () => {
    if (child?.exitCode == null && child?.signalCode == null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  };
  try {
    start();
    await ready();
    const duplicate = spawnSync(process.execPath, [path.join(root, 'src/index.js')], {
      cwd: f.directory,
      env,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /Verrou actif/);
    await kill();
    assert.ok(fs.existsSync(`${f.config.database}.lock`));
    start();
    await ready();
    assert.equal(Number(fs.readFileSync(path.join(`${f.config.database}.lock`, 'pid'), 'utf8')), child.pid);
  } finally {
    await kill();
  }
});
