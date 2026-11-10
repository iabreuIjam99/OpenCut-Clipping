import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearProviderKey,
  getProviderKey,
  hasProviderKey,
  PROVIDER_KEY_STORAGE_KEY,
  ProviderKeyError,
  setProviderKey,
} from "./byok"

const VALID_KEY = "sk-proveedor-clave-valida-para-pruebas-12345"
const CONTROL_KEYS = ["\n", "\r", "\u0000", "clave\rinterna", "clave\ninterna"]

function resetStorage(): void {
  window.sessionStorage.clear()
}

describe("setProviderKey", () => {
  beforeEach(resetStorage)
  afterEach(() => {
    vi.restoreAllMocks()
    resetStorage()
  })

  it("Scenario: La clave se guarda en sessionStorage y no en localStorage", () => {
    setProviderKey(VALID_KEY)
    expect(window.sessionStorage.getItem(PROVIDER_KEY_STORAGE_KEY)).toBe(VALID_KEY)
    expect(window.localStorage.getItem(PROVIDER_KEY_STORAGE_KEY)).toBeNull()
  })

  it("recorta la clave antes de guardarla", () => {
    setProviderKey(`  ${VALID_KEY}  `)
    expect(window.sessionStorage.getItem(PROVIDER_KEY_STORAGE_KEY)).toBe(VALID_KEY)
  })

  it("acepta una clave de exactamente 512 caracteres", () => {
    const key = "a".repeat(512)
    setProviderKey(key)
    expect(getProviderKey()).toBe(key)
  })

  it("rechaza una clave vacía tras recortar sin persistir", () => {
    let error: unknown
    try {
      setProviderKey("   ")
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ProviderKeyError)
    expect((error as ProviderKeyError).code).toBe("INVALID_KEY")
    expect((error as ProviderKeyError).message).not.toContain(VALID_KEY)
    expect(window.sessionStorage.getItem(PROVIDER_KEY_STORAGE_KEY)).toBeNull()
  })

  it("rechaza una clave de 513 caracteres sin persistir", () => {
    const tooLong = "a".repeat(513)
    expect(() => setProviderKey(tooLong)).toThrowError(ProviderKeyError)
    expect(window.sessionStorage.getItem(PROVIDER_KEY_STORAGE_KEY)).toBeNull()
  })

  it("Scenario: Una clave vacía o con caracteres de control se rechaza sin persistir", () => {
    for (const badKey of CONTROL_KEYS) {
      expect(() => setProviderKey(badKey)).toThrowError(ProviderKeyError)
    }
    expect(window.sessionStorage.getItem(PROVIDER_KEY_STORAGE_KEY)).toBeNull()
  })

  it("rechaza caracteres de control con código INVALID_KEY y mensaje genérico", () => {
    for (const badKey of CONTROL_KEYS) {
      let error: unknown
      try {
        setProviderKey(badKey)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(ProviderKeyError)
      expect((error as ProviderKeyError).code).toBe("INVALID_KEY")
      expect((error as ProviderKeyError).message).not.toContain(badKey)
      expect((error as ProviderKeyError).message).not.toContain(VALID_KEY)
    }
  })

  it("setItem que lanza (modo privado/cuota) → STORAGE_UNAVAILABLE sin la clave", () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("cuota excedida")
    })
    try {
      let error: unknown
      try {
        setProviderKey(VALID_KEY)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(ProviderKeyError)
      expect((error as ProviderKeyError).code).toBe("STORAGE_UNAVAILABLE")
      expect((error as ProviderKeyError).message).not.toContain(VALID_KEY)
      expect(window.sessionStorage.getItem(PROVIDER_KEY_STORAGE_KEY)).toBeNull()
    } finally {
      setItemSpy.mockRestore()
    }
  })
})

describe("getProviderKey, hasProviderKey, clearProviderKey", () => {
  beforeEach(resetStorage)
  afterEach(() => {
    vi.restoreAllMocks()
    resetStorage()
  })

  it("hasProviderKey devuelve false antes de guardar y true después", () => {
    expect(hasProviderKey()).toBe(false)
    expect(getProviderKey()).toBeNull()
    setProviderKey(VALID_KEY)
    expect(hasProviderKey()).toBe(true)
    expect(getProviderKey()).toBe(VALID_KEY)
  })

  it("Scenario: Borrar la clave es idempotente y deja hasProviderKey() en false", () => {
    setProviderKey(VALID_KEY)
    clearProviderKey()
    expect(hasProviderKey()).toBe(false)
    expect(getProviderKey()).toBeNull()
    expect(() => clearProviderKey()).not.toThrow()
    expect(hasProviderKey()).toBe(false)
    expect(getProviderKey()).toBeNull()
  })

  it("getProviderKey devuelve null tras borrar y ante valor vacío", () => {
    setProviderKey(VALID_KEY)
    clearProviderKey()
    expect(getProviderKey()).toBeNull()
    window.sessionStorage.setItem(PROVIDER_KEY_STORAGE_KEY, "   ")
    expect(getProviderKey()).toBeNull()
    expect(hasProviderKey()).toBe(false)
  })

  it("hasProviderKey y getProviderKey degradan sin lanzar ante errores de storage", () => {
    const getItemSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage roto")
    })
    try {
      expect(hasProviderKey()).toBe(false)
      expect(getProviderKey()).toBeNull()
    } finally {
      getItemSpy.mockRestore()
    }
  })

  it("clearProviderKey nunca lanza aunque removeItem falle", () => {
    const removeItemSpy = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("storage roto")
    })
    try {
      setProviderKey(VALID_KEY)
      expect(() => clearProviderKey()).not.toThrow()
      expect(() => clearProviderKey()).not.toThrow()
    } finally {
      removeItemSpy.mockRestore()
    }
  })

  it("el getter de sessionStorage que lanza → STORAGE_UNAVAILABLE / false / null sin que escape la clave", () => {
    const original = window.sessionStorage
    try {
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        get: () => {
          throw new DOMException("acceso denegado", "SecurityError")
        },
      })
      // El getter lanza al leer window.sessionStorage, no al llamar setItem/getItem.
      let error: unknown
      try {
        setProviderKey("gsk_test_clave_valida_para_pruebas")
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(ProviderKeyError)
      expect((error as ProviderKeyError).code).toBe("STORAGE_UNAVAILABLE")
      expect((error as ProviderKeyError).message).not.toContain(
        "gsk_test_clave_valida_para_pruebas",
      )
      expect(() => clearProviderKey()).not.toThrow()
      expect(hasProviderKey()).toBe(false)
      expect(getProviderKey()).toBeNull()
    } finally {
      // Restaurar la propiedad original de window.sessionStorage
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        value: original,
        writable: true,
      })
    }
  })
})
