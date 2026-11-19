// Minimal forward-only migration runner. State is tracked in _meta/migrations.
// Add files named NNN-description.js exporting `async function up(db)`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateConfig } from '../src/config.js';

validateConfig();
const { db } = await import('../src/firebase.js');
const dir = path.dirname(fileURLToPath(import.meta.url));
const stateRef = db.collection('_meta').doc('migrations');
const applied = new Set(((await stateRef.get()).data() || {}).applied || []);

const files = fs.readdirSync(dir).filter((f) => /^\d{3}-.+\.js$/.test(f)).sort();
for (const f of files) {
  if (applied.has(f)) continue;
  console.log(`applying ${f}`);
  await (await import(pathToFileURL(path.join(dir, f)).href)).up(db);
  applied.add(f);
  await stateRef.set({ applied: [...applied] }, { merge: true });
}
console.log('migrations up to date');
