/**
 * Almacenamiento de clave de proveedor (BYOK) en sessionStorage.
 *
 * La clave vive solo en `sessionStorage` (muere al cerrar la pestaña). Nunca
 * se persiste fuera de la pestaña actual —ni en almacenamiento duradero,
 * cookies, bases de datos del navegador ni la URL— y nunca se envía a
 * analytics ni logs. Toda la validación es estrictamente local.
 *
 * Cada acceso a `window.sessionStorage` está dentro de try/catch porque
 * leer la propiedad en sí misma puede lanzar (p. ej. `SecurityError` en un
 * iframe aislado sin `allow-same-origin`).
 *
 * @module byok
 */

export const PROVIDER_KEY_STORAGE_KEY = "monetizaclip.provider-key" // test seam

const MAX_KEY_LENGTH = 512

export class ProviderKeyError extends Error {
  readonly code: "INVALID_KEY" | "STORAGE_UNAVAILABLE"

  constructor(code: "INVALID_KEY" | "STORAGE_UNAVAILABLE", message: string) {
    super(message)
    this.name = "ProviderKeyError"
    this.code = code
  }
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * Valida y guarda la clave recortada en sessionStorage.
 *
 * @throws {ProviderKeyError} `code: "INVALID_KEY"` cuando la clave está vacía
 *   tras recortar, supera los 512 caracteres o contiene caracteres de control
 *   (incluidos `\r` y `\n`, inyección de cabeceras).
 * @throws {ProviderKeyError} `code: "STORAGE_UNAVAILABLE"` en SSR, sin
 *   `sessionStorage` o cuando `setItem` lanza (modo privado/cuota).
 *   El mensaje nunca contiene la clave.
 */
export function setProviderKey(key: string): void {
  const trimmed = key.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_KEY_LENGTH || hasControlChar(trimmed)) {
    throw new ProviderKeyError("INVALID_KEY", "La clave del proveedor no es válida.")
  }
  try {
    window.sessionStorage.setItem(PROVIDER_KEY_STORAGE_KEY, trimmed)
  } catch {
    throw new ProviderKeyError("STORAGE_UNAVAILABLE", "No se puede guardar la clave del proveedor.")
  }
}

/**
 * Elimina la clave de sessionStorage. Idempotente y nunca lanza.
 */
export function clearProviderKey(): void {
  try {
    window.sessionStorage.removeItem(PROVIDER_KEY_STORAGE_KEY)
  } catch {
    /* SSR o almacenamiento no disponible: nunca lanza */
  }
}

export function hasProviderKey(): boolean {
  try {
    const value = window.sessionStorage.getItem(PROVIDER_KEY_STORAGE_KEY)
    return value !== null && value.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Devuelve la clave recortada, o `null` si no hay ninguna. En SSR o ante
 * errores de almacenamiento devuelve `null` sin lanzar. Necesaria para que el
 * cliente HTTP construya la cabecera `x-provider-key` (Task 19).
 */
export function getProviderKey(): string | null {
  try {
    const value = window.sessionStorage.getItem(PROVIDER_KEY_STORAGE_KEY)
    if (value === null) return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}
