// The environment build's cache (README "Performance", the real look only: envlook.ts): its
// generated data (the ground textures, the leaf card, the town's terrain field: typed arrays,
// deterministic for a build) kept in IndexedDB under the build's stamp, so a repeat visit skips
// the generators. Loaded whole before the build (RealLook.prepare), written once after it; any
// other build's entries are dropped then. No IndexedDB (a private window, a test): a plain
// in-memory map, every build a miss. A "dev" build never caches (its layout moves under it).
export type EnvArrays = Record<string, Uint8Array | Uint16Array | Float32Array>;

export interface EnvCache {
  /** `name`'s arrays from the cache, else make() (and kept, for save()) */
  memo(name: string, make: () => EnvArrays): EnvArrays;
  readonly hits: string[];
  readonly misses: string[];
  /** writes what memo() made; drops other builds' entries */
  save(): Promise<void>;
}

const DB = "silver-tongue-world3d-env";
const STORE = "env";
/** the generators' format: bump when envlook.ts changes what they make */
export const ENV_CACHE_FORMAT = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error("env cache: blocked"));
  });
}

/** A cache over `entries` (what the store had for this build); `persist` writes the made ones. */
export function memoryCache(entries = new Map<string, EnvArrays>(), persist?: (made: Map<string, EnvArrays>) => Promise<void>): EnvCache {
  const made = new Map<string, EnvArrays>();
  const hits: string[] = [];
  const misses: string[] = [];
  return {
    hits,
    misses,
    memo(name, make) {
      const had = entries.get(name);
      if (had) {
        hits.push(name);
        return had;
      }
      misses.push(name);
      const v = make();
      made.set(name, v);
      entries.set(name, v);
      return v;
    },
    async save() {
      if (made.size && persist) await persist(made);
      made.clear();
    },
  };
}

/** The cache for build `stamp` (version.ts BUILD); never throws (a failure: an empty, unsaved cache). */
export async function openEnvCache(stamp: string): Promise<EnvCache> {
  if (stamp === "dev" || typeof indexedDB === "undefined") return memoryCache();
  const prefix = `${ENV_CACHE_FORMAT}|${stamp}|`;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const keys = (await req(store.getAllKeys())) as string[];
    const entries = new Map<string, EnvArrays>();
    for (const k of keys.filter((k) => k.startsWith(prefix))) entries.set(k.slice(prefix.length), (await req(store.get(k))) as EnvArrays);
    return memoryCache(entries, async (made) => {
      try {
        const w = db.transaction(STORE, "readwrite");
        const s = w.objectStore(STORE);
        for (const k of keys) if (!k.startsWith(prefix)) s.delete(k);
        for (const [name, v] of made) s.put(v, prefix + name);
        await new Promise<void>((res, rej) => {
          w.oncomplete = () => res();
          w.onerror = () => rej(w.error);
          w.onabort = () => rej(w.error);
        });
      } catch (e) {
        console.warn("env cache: not saved", e);
      }
    });
  } catch (e) {
    console.warn("env cache: unavailable", e);
    return memoryCache();
  }
}
