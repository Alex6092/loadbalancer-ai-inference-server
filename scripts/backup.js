import fs from 'node:fs';
import path from 'node:path';
import { configuration } from '../src/config.js';
import { openDatabase } from '../src/db.js';

const config = configuration();
if (!fs.existsSync(config.database)) throw new Error('Base inexistante : aucune sauvegarde créée.');
const directory = path.resolve(path.dirname(config.database), 'backups');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const target = path.join(directory, `service-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
const db = openDatabase(config.database);
try {
  // SQLite online backup API includes committed WAL data without copying live files.
  await db.backup(target);
  fs.chmodSync(target, 0o600);
  console.log(`Sauvegarde créée : ${target}`);
} finally {
  db.close();
}
