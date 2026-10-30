import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

if (fs.existsSync('.env')) {
  console.log('.env existe déjà ; aucun secret modifié.');
} else {
  const template = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  fs.writeFileSync(
    '.env',
    template.replace('GENERER_AVEC_NPM_RUN_INIT', randomBytes(32).toString('base64')),
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    '.env créé. Conserver sa clé de chiffrement avec vos sauvegardes, dans un emplacement distinct.',
  );
}
