import { randomUUID } from 'node:crypto';
import readline from 'node:readline/promises';
import { configuration } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { passwordHash } from '../src/security.js';

async function password() {
  if (!process.stdin.isTTY) {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    return input.replace(/\r?\n$/, '');
  }
  process.stdout.write('Mot de passe (12 caractères minimum, saisie masquée) : ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const done = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stdout.write('\n');
    };
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\u0003') {
          done();
          reject(new Error('Annulé.'));
          return;
        }
        if (c === '\r' || c === '\n') {
          done();
          resolve(value);
          return;
        }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else if (c >= ' ') value += c;
      }
    };
    process.stdin.on('data', onData);
  });
}

let db;
try {
  let username = process.argv[2];
  if (!username && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    username = await rl.question('Identifiant administrateur : ');
    rl.close();
  }
  if (!username?.trim() || username.length > 200)
    throw new Error(
      'Usage : npm run admin:create -- identifiant ; fournir le mot de passe sur stdin ou en saisie masquée.',
    );
  const digest = await passwordHash(await password());
  const config = configuration();
  db = openDatabase(config.database);
  db.prepare('INSERT INTO admins VALUES (?, ?, ?, ?)').run(randomUUID(), username.trim(), digest, Date.now());
  console.log(`Administrateur ${username.trim()} créé.`);
} catch (error) {
  console.error(error.code?.startsWith('SQLITE_CONSTRAINT') ? 'Cet identifiant existe déjà.' : error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
