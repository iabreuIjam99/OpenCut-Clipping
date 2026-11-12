/**
 * Stand-in for `node:async_hooks` in the BROWSER environment only (see
 * `vite.config.ts`, `createClientAsyncHooksShim`).
 *
 * This plugin replaces the `node:async_hooks` builtin with a harmless stub
 * **only** in the client environment (`environment.name === "client"`). The
 * server (Workers with `nodejs_compat`) retains the real implementation that
 * uses request context (`AsyncLocalStorage`), so there is no runtime impact.
 *
 * Why this exists: `@tanstack/start-client-core` pulls
 * `@tanstack/start-storage-context` into the client graph, and that module runs
 * `new AsyncLocalStorage()` at module scope. In a browser, `node:async_hooks`
 * is externalized, so the constructor is not callable and the whole app fails
 * before hydration:
 *
 *   TypeError: AsyncLocalStorage is not a constructor
 *
 * The plugin's `resolveId` hook only intercepts `node:async_hooks` imports
 * that originate from `@tanstack/start-storage-context` (or its dist folder),
 * keeping blast radius minimal. All other `node:async_hooks` references pass
 * through unchanged.
 *
 * The `run` method is synchronous-only; `enterWith` and `bind` are intentionally
 * omitted because the client graph never uses them. If they were added later,
 * they must fail noisily (not silently).
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
