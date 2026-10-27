/**
 * Tiny in-memory memo: one value per key, fresh for `ttlMs`. Per server instance, so a cold
 * function starts empty — that is fine, every caller refetches on a miss.
 */
export function ttlCache<K, V>(ttlMs: number) {
  const store = new Map<K, { at: number; v: V }>();
  return {
    get(k: K): V | undefined {
      const h = store.get(k);
      return h && Date.now() - h.at < ttlMs ? h.v : undefined;
    },
    set(k: K, v: V): V {
      store.set(k, { at: Date.now(), v });
      return v;
    },
  };
}
