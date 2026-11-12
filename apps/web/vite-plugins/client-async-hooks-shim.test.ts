import { describe, expect, it } from "vitest"
import {
  createClientAsyncHooksShim,
  isClientEnvironment,
  shouldShimAsyncHooks,
} from "./client-async-hooks-shim"

describe("client-async-hooks-shim", () => {
  describe("isClientEnvironment", () => {
    it("returns true for 'client'", () => {
      expect(isClientEnvironment("client")).toBe(true)
    })

    it("returns false for 'ssr'", () => {
      expect(isClientEnvironment("ssr")).toBe(false)
    })

    it("returns false for 'server'", () => {
      expect(isClientEnvironment("server")).toBe(false)
    })

    it("returns false for empty string", () => {
      expect(isClientEnvironment("")).toBe(false)
    })
  })

  describe("shouldShimAsyncHooks", () => {
    it("returns true for @tanstack/start-storage-context/dist/esm path", () => {
      const result = shouldShimAsyncHooks(
        "node:async_hooks",
        "/repo/node_modules/@tanstack/start-storage-context/dist/esm/async-local-storage.js",
      )
      expect(result).toBe(true)
    })

    it("returns true with Windows separators", () => {
      const result = shouldShimAsyncHooks(
        "node:async_hooks",
        "/repo/node_modules/@tanstack/start-storage-context\\dist\\esm\\async-local-storage.js".replace(
          /\\/g,
          "\\",
        ),
      )
      expect(result).toBe(true)
    })

    it("returns true for bare package id", () => {
      const result = shouldShimAsyncHooks(
        "node:async_hooks",
        "/repo/node_modules/@tanstack/start-storage-context/index.js",
      )
      expect(result).toBe(true)
    })

    it("returns true for bare package id (just the name)", () => {
      const result = shouldShimAsyncHooks("node:async_hooks", "@tanstack/start-storage-context")
      expect(result).toBe(true)
    })

    it("returns false for a different package", () => {
      const result = shouldShimAsyncHooks("node:async_hooks", "/repo/node_modules/otro/index.js")
      expect(result).toBe(false)
    })

    it("returns false for node:fs", () => {
      const result = shouldShimAsyncHooks("node:fs", undefined)
      expect(result).toBe(false)
    })

    it("returns false when importer is undefined", () => {
      const result = shouldShimAsyncHooks("node:async_hooks", undefined)
      expect(result).toBe(false)
    })

    it("returns false for a project file", () => {
      const result = shouldShimAsyncHooks("node:async_hooks", "/repo/src/main.ts")
      expect(result).toBe(false)
    })

    it("returns false for node:async_hooks with non-matching source", () => {
      const result = shouldShimAsyncHooks(
        "node:fs",
        "/repo/node_modules/@tanstack/start-storage-context/dist/esm/async-local-storage.js",
      )
      expect(result).toBe(false)
    })

    it("returns false for lookalike package name", () => {
      const result = shouldShimAsyncHooks(
        "node:async_hooks",
        "/repo/node_modules/@tanstack/start-storage-context-evil/index.js",
      )
      expect(result).toBe(false)
    })

    it("returns false for path containing string but not as package segment", () => {
      const result = shouldShimAsyncHooks(
        "node:async_hooks",
        "/repo/src/@tanstack/start-storage-context-notes.md",
      )
      expect(result).toBe(false)
    })
  })

  describe("createClientAsyncHooksShim", () => {
    it("returns a plugin with correct name and enforce", () => {
      const plugin = createClientAsyncHooksShim({ shimPath: "/x/shim.ts" })
      expect(plugin.name).toBe("client-async-hooks-shim")
      expect(plugin.enforce).toBe("pre")
    })

    it("typeof plugin.resolveId is 'function'", () => {
      const plugin = createClientAsyncHooksShim({ shimPath: "/x/shim.ts" })
      expect(typeof plugin.resolveId).toBe("function")
    })

    it("plugin.applyToEnvironment filters by client environment", () => {
      const plugin = createClientAsyncHooksShim({ shimPath: "/x/shim.ts" })
      expect(plugin.applyToEnvironment({ name: "client" })).toBe(true)
      expect(plugin.applyToEnvironment({ name: "ssr" })).toBe(false)
      expect(plugin.applyToEnvironment({ name: "server" })).toBe(false)
    })

    it("plugin.resolveId returns shimPath for matching imports", () => {
      const shimPath = "/tmp/async-hooks-browser.ts"
      const plugin = createClientAsyncHooksShim({ shimPath })
      const storageContextImporter =
        "/repo/node_modules/@tanstack/start-storage-context/dist/esm/async-local-storage.js"

      expect(plugin.resolveId("node:async_hooks", storageContextImporter)).toBe(shimPath)
      expect(plugin.resolveId("node:async_hooks", "/repo/src/main.ts")).toBe(null)
      expect(plugin.resolveId("node:fs", storageContextImporter)).toBe(null)
    })
  })
})
