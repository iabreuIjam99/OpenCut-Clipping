import type { Plugin } from "vite"

export const TANSTACK_STORAGE_CONTEXT = "@tanstack/start-storage-context"

export type ClientAsyncHooksShimPlugin = Plugin & {
  applyToEnvironment: (environment: { name: string }) => boolean
  resolveId: (source: string, importer: string | undefined) => string | null
}

export function createClientAsyncHooksShim(options: {
  shimPath: string
}): ClientAsyncHooksShimPlugin {
  return {
    name: "client-async-hooks-shim",
    applyToEnvironment: (environment) => isClientEnvironment(environment.name),
    enforce: "pre",
    resolveId(source: string, importer: string | undefined) {
      if (!shouldShimAsyncHooks(source, importer)) return null
      return options.shimPath
    },
  }
}

export function isClientEnvironment(name: string): boolean {
  return name === "client"
}

export function shouldShimAsyncHooks(source: string, importer: string | undefined): boolean {
  if (source !== "node:async_hooks") return false
  if (importer === undefined) return false

  const normalized = importer.replaceAll("\\", "/")

  const isTanStackStorageContext =
    normalized === TANSTACK_STORAGE_CONTEXT ||
    normalized.includes(`/node_modules/${TANSTACK_STORAGE_CONTEXT}/`) ||
    normalized.includes(`/${TANSTACK_STORAGE_CONTEXT}/dist/`)

  return isTanStackStorageContext
}
