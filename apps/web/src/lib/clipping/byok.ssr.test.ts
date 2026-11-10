// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  clearProviderKey,
  getProviderKey,
  hasProviderKey,
  PROVIDER_KEY_STORAGE_KEY,
  ProviderKeyError,
  setProviderKey,
} from "./byok"

describe("BYOK en SSR (sin `window`)", () => {
  it("Scenario: Sin sessionStorage (SSR o modo privado que lanza), el error es genérico y no contiene la clave", () => {
    let error: unknown
    try {
      setProviderKey("clave-valida-123")
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ProviderKeyError)
    expect((error as ProviderKeyError).code).toBe("STORAGE_UNAVAILABLE")
    expect((error as ProviderKeyError).message).not.toContain("clave-valida-123")
    expect((error as ProviderKeyError).message).not.toMatch(/sessionStorage|Storage|setItem/i)
  })

  it("getProviderKey devuelve null sin window", () => {
    expect(getProviderKey()).toBeNull()
  })

  it("hasProviderKey devuelve false sin window", () => {
    expect(hasProviderKey()).toBe(false)
  })

  it("clearProviderKey nunca lanza sin window", () => {
    expect(() => clearProviderKey()).not.toThrow()
  })

  it("PROVIDER_KEY_STORAGE_KEY está exportado como costura de prueba", () => {
    expect(PROVIDER_KEY_STORAGE_KEY).toBe("monetizaclip.provider-key")
  })
})
