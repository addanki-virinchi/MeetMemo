// Test harness: fake Chrome extension APIs shared across several "contexts" (popup, viewer,
// worker, meeting tab), plus loaders that run the real extension files in isolated VM contexts.
// No network, browser, Firebase or real account data is involved.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
export const tick = () => new Promise((r) => setImmediate(r));
export async function settle(n = 20) { for (let i = 0; i < n; i += 1) await tick(); }

export function deferred() {
  let resolve; let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

// One browser profile: storage areas shared by every context, change events fan out to all.
export function createBrowser({ extId = 'ext' } = {}) {
  const areas = { local: new Map(), session: new Map() };
  const changeListeners = new Set();
  const connectListeners = new Set(); // worker onConnect
  const messageListeners = new Set(); // worker onMessage
  const opened = [];
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));

  function area(name) {
    const data = areas[name];
    const emit = (changes) => {
      if (!Object.keys(changes).length) return;
      // Chrome delivers change events asynchronously to every context.
      setImmediate(() => changeListeners.forEach((l) => l(structuredClone(changes), name)));
    };
    return {
      data,
      async get(keys) {
        await tick();
        if (keys === null || keys === undefined) return Object.fromEntries([...data].map(([k, v]) => [k, clone(v)]));
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (data.has(k)) out[k] = clone(data.get(k));
        return out;
      },
      async set(obj) {
        await tick();
        const changes = {};
        for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: clone(data.get(k)), newValue: clone(v) }; data.set(k, clone(v)); }
        emit(changes);
      },
      async remove(keys) {
        await tick();
        const changes = {};
        for (const k of Array.isArray(keys) ? keys : [keys]) if (data.has(k)) { changes[k] = { oldValue: clone(data.get(k)) }; data.delete(k); }
        emit(changes);
      },
    };
  }
  const local = area('local');
  const session = area('session');

  function makePort(name, sender) {
    const a = { listeners: new Set(), disc: new Set() };
    const b = { listeners: new Set(), disc: new Set() };
    let open = true;
    const side = (me, other) => ({
      name,
      sender,
      onMessage: { addListener: (f) => me.listeners.add(f) },
      onDisconnect: { addListener: (f) => me.disc.add(f) },
      postMessage(m) {
        if (!open) throw new Error('Attempting to use a disconnected port object');
        const copy = structuredClone(m);
        setImmediate(() => { if (open) other.listeners.forEach((f) => f(copy)); });
      },
      disconnect() { if (!open) return; open = false; setImmediate(() => other.disc.forEach((f) => f())); },
    });
    return { client: side(a, b), server: side(b, a), kill() { open = false; a.disc.forEach((f) => f()); b.disc.forEach((f) => f()); } };
  }

  // chrome API for one context. url is the sender URL other contexts will see.
  function chromeFor({ url = `chrome-extension://${extId}/page.html`, tab } = {}) {
    return {
      runtime: {
        id: extId,
        lastError: undefined,
        getURL: (p) => `chrome-extension://${extId}/${p}`,
        connect({ name }) {
          const p = makePort(name, { id: extId, url, tab });
          setImmediate(() => connectListeners.forEach((l) => l(p.server)));
          return p.client;
        },
        onConnect: { addListener: (f) => connectListeners.add(f) },
        onMessage: { addListener: (f) => messageListeners.add(f) },
        async sendMessage(msg) {
          const copy = structuredClone(msg);
          setImmediate(() => messageListeners.forEach((l) => l(copy, { id: extId, url, tab }, () => {})));
        },
      },
      storage: {
        local,
        session,
        onChanged: { addListener: (f) => changeListeners.add(f), removeListener: (f) => changeListeners.delete(f) },
      },
      tabs: { create: async (o) => { opened.push({ kind: 'tab', ...o }); return o; } },
      windows: { create: async (o) => { opened.push({ kind: 'window', ...o }); return o; } },
      alarms: { create() {}, onAlarm: { addListener() {} } },
    };
  }

  return { local, session, chromeFor, opened, changeListeners, connectListeners, messageListeners };
}

// Runs classic scripts in a fresh context with the given globals; returns the context (self).
export function runClassic(files, globals) {
  // Timers are unref'd so retry/backoff timers never keep the test process alive.
  const unref = (t) => { t?.unref?.(); return t; };
  const ctx = vm.createContext({
    setTimeout: (f, ms) => unref(setTimeout(f, ms)),
    setInterval: (f, ms) => unref(setInterval(f, ms)),
    console, clearTimeout, clearInterval, setImmediate, structuredClone,
    TextEncoder, URL, URLSearchParams, AbortSignal, Promise, Map, Set, Date, JSON, Math, Object, Array, Error, Number, String,
    crypto: globalThis.crypto,
    ...globals,
  });
  ctx.self = ctx;
  for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
  return ctx;
}

// Loads an ES-module extension page file by rewriting its relative imports to injected deps.
export function runModulePage(file, globals, deps) {
  let src = read(file);
  src = src.replace(/^import \{([^}]+)\} from '[^']+';$/gm, (_, names) => `const {${names}} = __deps;`);
  src = src.replace(/^import '[^']+';$/gm, '');
  if (/^\s*import\s/m.test(src) || /^\s*export\s/m.test(src)) throw new Error(`unsupported module syntax in ${file}`);
  const ctx = runClassic([], { ...globals, __deps: deps });
  vm.runInContext(`(async () => {\n${src}\n})().catch((e) => { self.__error = e; })`, ctx, { filename: file });
  return ctx;
}

// Loads extension-auth/manualAuthProvider.js + session.js for one page context.
export function loadProvider(chromeApi, fetchImpl) {
  const ctx = runClassic(['extension-auth/session.js'], { chrome: chromeApi });
  const src = read('extension-auth/manualAuthProvider.js')
    .replace("import './session.js';", '')
    .replace('export function createManualAuthProvider', 'self.createManualAuthProvider = function createManualAuthProvider');
  vm.runInContext(src, ctx, { filename: 'manualAuthProvider.js' });
  return ctx.createManualAuthProvider({ baseUrl: 'http://api.test', chromeApi, fetchImpl });
}

export function loadApiClient(ctxGlobals = {}) {
  const ctx = runClassic([], ctxGlobals);
  const src = read('extension-auth/apiClient.js').replace('export function createApiClient', 'self.createApiClient = function createApiClient');
  vm.runInContext(src, ctx, { filename: 'apiClient.js' });
  return ctx.createApiClient;
}

// Minimal JSON Response.
export const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
