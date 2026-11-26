// Minimal in-memory stand-in for the Firestore Admin API surface used by meetingsRouter.js.
// Only what the routes call is implemented; ordering semantics mirror Firestore
// (orderBy fields, then document id; startAfter takes the same number of values).
const DOC_ID = Symbol('documentId');
export const FieldPath = { documentId: () => DOC_ID };
const SERVER_TS = Symbol('serverTimestamp');
export const FieldValue = { serverTimestamp: () => SERVER_TS };

let autoId = 0;
const resolve = (data) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === SERVER_TS ? new Date() : v]));

function snapshot(ref, data) {
  return { id: ref.id, ref, exists: data !== undefined, data: () => (data === undefined ? undefined : structuredClone(data)) };
}

export function createFakeFirestore() {
  const store = new Map(); // path -> data
  const stats = { reads: 0, queries: [] };

  function docRef(path) {
    const id = path.split('/').pop();
    return {
      id,
      path,
      async get() { stats.reads += 1; return snapshot(this, store.get(path)); },
      async set(data, opts) { writeDoc(path, data, opts); },
      async update(data) { updateDoc(path, data); },
      async delete() { store.delete(path); },
      collection: (name) => collectionRef(`${path}/${name}`),
    };
  }

  function writeDoc(path, data, opts) {
    const base = opts?.merge ? store.get(path) || {} : {};
    store.set(path, { ...base, ...resolve(data) });
  }
  function updateDoc(path, data) {
    if (!store.has(path)) throw Object.assign(new Error(`No document to update: ${path}`), { code: 5 });
    store.set(path, { ...store.get(path), ...resolve(data) });
  }

  function query(colPath, spec) {
    const with_ = (patch) => query(colPath, { ...spec, ...patch });
    return {
      where: (field, op, value) => { if (op !== '==') throw new Error('fake supports == only'); return with_({ where: [...spec.where, [field, value]] }); },
      orderBy: (field, dir = 'asc') => with_({ order: [...spec.order, [field, dir]] }),
      limit: (n) => with_({ limit: n }),
      startAfter: (...values) => with_({ after: values }),
      async get() {
        stats.queries.push({ colPath, ...spec });
        const prefix = `${colPath}/`;
        let docs = [...store.entries()]
          .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
          .map(([p, d]) => ({ ref: docRef(p), data: d }))
          .filter(({ data }) => spec.where.every(([f, v]) => data[f] === v));
        const order = [...spec.order];
        if (!order.some(([f]) => f === DOC_ID)) order.push([DOC_ID, 'asc']);
        const key = (doc, f) => (f === DOC_ID ? doc.ref.id : doc.data[f]);
        const cmp = (a, b) => {
          for (const [f, dir] of order) {
            const x = key(a, f); const y = key(b, f);
            const c = x < y ? -1 : x > y ? 1 : 0;
            if (c) return dir === 'desc' ? -c : c;
          }
          return 0;
        };
        docs.sort(cmp);
        if (spec.after) {
          const [first] = spec.after;
          let cursor;
          if (first && typeof first === 'object' && 'ref' in first) cursor = { ref: first.ref, data: first.data() };
          else {
            // Values map onto the order fields in sequence.
            const data = {}; let id = '';
            order.forEach(([f], i) => { if (i < spec.after.length) { if (f === DOC_ID) id = spec.after[i]; else data[f] = spec.after[i]; } });
            cursor = { ref: { id }, data };
          }
          const n = first && typeof first === 'object' && 'ref' in first ? order.length : spec.after.length;
          const partial = (a, b) => {
            for (const [f, dir] of order.slice(0, n)) {
              const x = key(a, f); const y = key(b, f);
              const c = x < y ? -1 : x > y ? 1 : 0;
              if (c) return dir === 'desc' ? -c : c;
            }
            return 0;
          };
          docs = docs.filter((d) => partial(d, cursor) > 0);
        }
        if (spec.limit !== undefined) docs = docs.slice(0, spec.limit);
        stats.reads += docs.length;
        const out = docs.map((d) => snapshot(d.ref, d.data));
        return { docs: out, size: out.length, empty: out.length === 0 };
      },
    };
  }

  function collectionRef(path) {
    return {
      ...query(path, { where: [], order: [] }),
      doc: (id) => docRef(`${path}/${id ?? `auto${++autoId}`}`),
    };
  }

  // Transactions apply writes at commit; hooks let tests interleave other writes.
  async function runTransaction(fn) {
    const writes = [];
    const tx = {
      async getAll(...refs) { stats.reads += refs.length; return refs.map((r) => snapshot(r, store.get(r.path))); },
      async get(ref) { stats.reads += 1; return snapshot(ref, store.get(ref.path)); },
      set(ref, data, opts) { writes.push(() => writeDoc(ref.path, data, opts)); return tx; },
      update(ref, data) { writes.push(() => updateDoc(ref.path, data)); return tx; },
    };
    const out = await fn(tx);
    writes.forEach((w) => w());
    return out;
  }

  return {
    store,
    stats,
    collection: collectionRef,
    runTransaction,
    batch() {
      const writes = [];
      const b = {
        set(ref, data, opts) { writes.push(() => writeDoc(ref.path, data, opts)); return b; },
        update(ref, data) { writes.push(() => updateDoc(ref.path, data)); return b; },
        delete(ref) { writes.push(() => store.delete(ref.path)); return b; },
        async commit() { writes.forEach((w) => w()); },
      };
      return b;
    },
    async recursiveDelete(ref) {
      for (const p of [...store.keys()]) if (p === ref.path || p.startsWith(`${ref.path}/`)) store.delete(p);
    },
  };
}
