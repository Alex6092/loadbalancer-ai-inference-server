import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let count = 0;
for (const directory of ['src', 'scripts', 'public', 'test', 'examples']) {
  if (!fs.existsSync(directory)) continue;
  for (const file of fs.readdirSync(directory, { recursive: true })) {
    if (!file.endsWith('.js')) continue;
    const target = path.join(directory, file);
    const result = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
    if (result.status !== 0) {
      process.stderr.write(result.stderr);
      process.exitCode = 1;
    }
    count++;
  }
}
const spec = JSON.parse(fs.readFileSync('docs/openapi.json', 'utf8'));
if (!spec.openapi || !spec.paths) throw new Error('Spécification OpenAPI invalide.');
console.log(`${count} fichiers JavaScript vérifiés ; spécification OpenAPI lisible.`);
