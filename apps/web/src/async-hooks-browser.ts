/**
 * Stand-in for `node:async_hooks` in the BROWSER environment only (see
 * `vite.config.ts`, `environments.client.resolve.alias`).
 *
 * Why this exists: `@tanstack/start-client-core` pulls
 * `@tanstack/start-storage-context` into the client graph, and that module runs
 * `new AsyncLocalStorage()` at module scope. In a browser `node:async_hooks`
 * is externalized, so the constructor is not callable and the whole app fails
 * before hydration:
 *
 *   TypeError: import_browser_external_node_async_hooks.AsyncLocalStorage
 *   is not a constructor
 *
 * The server keeps the real implementation (the alias is client-only), so
 * request context is unaffected. On the client the store is only meaningful
 * for server-only code paths that must never run; an empty store is the
 * correct browser semantics and `getStartContext()` still throws its normal
 * "No Start context found" error if a server path is reached.
 */
export class AsyncLocalStorage<T = unknown> {
  #store: T | undefined

  run<R>(store: T, callback: () => R): R {
    const previous = this.#store
    this.#store = store
    try {
      return callback()
    } finally {
      this.#store = previous
    }
  }

  getStore(): T | undefined {
    return this.#store
  }
}

export default { AsyncLocalStorage }
