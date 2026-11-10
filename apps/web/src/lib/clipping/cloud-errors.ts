/**
 * Contrato de errores del proxy de transcripción y degradación a local.
 *
 * `toCloudFailure` es puro y nunca lanza: mapea cualquier entrada (status HTTP,
 * payload del proxy `{ error: { code } }` o basura) a un `CloudFailure` con
 * mensajes genéricos en español. Nunca filtra cuerpos, rutas, stacks ni la
 * clave del proveedor.
 *
 * @module cloud-errors
 */

export type CloudErrorCode =
  | "UNAUTHORIZED"
  | "UNSUPPORTED_MEDIA"
  | "QUOTA_EXCEEDED"
  | "UPSTREAM_ERROR"
  | "NETWORK"

export type CloudFailure = {
  readonly code: CloudErrorCode
  readonly fallbackToLocal: boolean
  readonly message: string
}

export class CloudTranscriptionError extends Error {
  readonly code: CloudErrorCode
  readonly fallbackToLocal: boolean

  constructor(code: CloudErrorCode, fallbackToLocal: boolean, message: string) {
    super(message)
    this.name = "CloudTranscriptionError"
    this.code = code
    this.fallbackToLocal = fallbackToLocal
  }
}

const MESSAGES: Record<CloudErrorCode, string> = {
  UNAUTHORIZED: "No autorizado.",
  UNSUPPORTED_MEDIA: "Formato no soportado.",
  QUOTA_EXCEEDED: "Cuota agotada; puedes usar el modo local.",
  UPSTREAM_ERROR: "El servicio no está disponible; puedes usar el modo local.",
  NETWORK: "Sin conexión; puedes usar el modo local.",
}

const FALLBACK_TO_LOCAL: Record<CloudErrorCode, boolean> = {
  UNAUTHORIZED: false,
  UNSUPPORTED_MEDIA: false,
  QUOTA_EXCEEDED: true,
  UPSTREAM_ERROR: true,
  NETWORK: true,
}

function isCloudErrorCode(value: string): value is CloudErrorCode {
  return (
    value === "UNAUTHORIZED" ||
    value === "UNSUPPORTED_MEDIA" ||
    value === "QUOTA_EXCEEDED" ||
    value === "UPSTREAM_ERROR" ||
    value === "NETWORK"
  )
}

function failure(code: CloudErrorCode): CloudFailure {
  return {
    code,
    fallbackToLocal: FALLBACK_TO_LOCAL[code],
    message: MESSAGES[code],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function proxyErrorCode(input: unknown): string | null {
  if (!isRecord(input)) return null
  const error = input.error
  if (!isRecord(error)) return null
  const code = error.code
  return typeof code === "string" ? code : null
}

/**
 * Mapea cualquier entrada a un `CloudFailure` sin lanzar: status HTTP, payload
 * del proxy o basura (`null`, array, string, objeto sin `error.code` conocido).
 * Nunca incluye el cuerpo upstream, rutas, stacks ni la clave.
 */
export function toCloudFailure(input: unknown): CloudFailure {
  if (typeof input === "number") {
    switch (input) {
      case 401:
        return failure("UNAUTHORIZED")
      case 413:
      case 415:
        return failure("UNSUPPORTED_MEDIA")
      case 429:
        return failure("QUOTA_EXCEEDED")
      case 502:
        return failure("UPSTREAM_ERROR")
      case 0:
        return failure("NETWORK")
      default:
        return failure("UPSTREAM_ERROR")
    }
  }
  if (input === null) return failure("NETWORK")
  const code = proxyErrorCode(input)
  if (code !== null && isCloudErrorCode(code)) {
    return failure(code)
  }
  return failure("UPSTREAM_ERROR")
}

/**
 * Azúcar sobre {@link toCloudFailure} a partir de un status HTTP. `payload`
 * se ignora a propósito: el cuerpo del proxy nunca se filtra en este contrato.
 */
export function fromHttpResponse(status: number, payload?: unknown): CloudFailure {
  void payload
  return toCloudFailure(status)
}
