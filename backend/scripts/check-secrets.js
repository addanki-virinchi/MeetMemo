// Fails if service-account material appears in the extension bundle or its other files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const patterns = [/BEGIN (RSA |EC )?PRIVATE KEY/, /"private_key_id"/, /firebase-adminsdk-[a-z0-9]+@/, /sk-ant-[A-Za-z0-9_-]{20,}/];
const skip = new Set(['node_modules', 'backend', '.git']);
let bad = 0;

(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|json|html|css|md|txt)$/.test(e.name)) {
      const t = fs.readFileSync(p, 'utf8');
      for (const re of patterns) if (re.test(t)) { console.error(`SECRET? ${re} in ${p}`); bad++; }
    }
  }
})(extRoot);

if (bad) process.exit(1);
console.log('No service-account material or API keys found in extension files.');
