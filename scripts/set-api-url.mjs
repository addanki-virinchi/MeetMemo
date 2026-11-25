// Points the extension at a backend: node scripts/set-api-url.mjs https://your-api.example.com
// Updates meetmemo.config.js (apiBaseUrl) and manifest.json host_permissions together.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];
let url;
try { url = new URL(arg); } catch { /* handled below */ }
if (!url || !/^https?:$/.test(url.protocol) || (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname))) {
  console.error('Usage: node scripts/set-api-url.mjs <https-url>   (http only allowed for localhost)');
  process.exit(1);
}
const base = url.origin;

const cfgPath = path.join(root, 'meetmemo.config.js');
const cfg = readFileSync(cfgPath, 'utf8');
if (!/apiBaseUrl: '[^']*'/.test(cfg)) throw new Error('apiBaseUrl not found in meetmemo.config.js');
writeFileSync(cfgPath, cfg.replace(/apiBaseUrl: '[^']*'/, `apiBaseUrl: '${base}'`));

const manPath = path.join(root, 'manifest.json');
const raw = readFileSync(manPath, 'utf8');
const man = JSON.parse(raw);
const isApi = (h) => /^https?:\/\/[^*]/.test(h);        // the previous API entry (not the *://meet.google.com one)
man.host_permissions = [...man.host_permissions.filter((h) => !isApi(h)), `${base}/*`];
writeFileSync(manPath, JSON.stringify(man, null, 1) + (raw.endsWith('\n') ? '\n' : ''));
console.log(`Extension now targets ${base}. Reload it at chrome://extensions.`);
