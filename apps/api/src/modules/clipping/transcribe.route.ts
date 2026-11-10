import { Elysia } from "elysia"
import { asRecord, toTranscript, transcribeWithGroq } from "./providers/groq"
import { consumeQuota, hashIp, type QuotaStore } from "./quota"
import type { TurnstileVerifier } from "./turnstile"

function isValidProviderKey(key: string): boolean {
  const trimmed = key.trim()
  return trimmed.length >= 1 && trimmed.length <= 512
}

function json(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  })
}

export type RuntimeSecurity = {
  turnstile: TurnstileVerifier | null
  quota: { store: QuotaStore; limit: number } | null
  ipHashSalt: string | null
  required: boolean
}

export type TranscribeRouteOptions = {
  security: RuntimeSecurity
}

export function createTranscribeRoute(options: TranscribeRouteOptions) {
  const { security } = options

  const route = new Elysia({ name: "clipping.transcribe" }).post(
    "/v1/transcribe",
    async ({ request }) => {
      // 1. Validar x-provider-key (BYOK)
      const providerKey = request.headers.get("x-provider-key")
      if (!providerKey || !isValidProviderKey(providerKey)) {
        return json(
          {
            error: {
              code: "UNAUTHORIZED",
              message: "No autorizado.",
            },
          },
          401,
        )
      }

      // 2. Validar Content-Type multipart con boundary
      const contentType = request.headers.get("content-type") ?? ""
      const lowerContentType = contentType.toLowerCase()
      const hasMultipartBoundary =
        lowerContentType.includes("multipart/form-data") && lowerContentType.includes("boundary=")
      if (!hasMultipartBoundary) {
        return json(
          {
            error: {
              code: "UNSUPPORTED_MEDIA",
              message: "Content-Type debe ser multipart/form-data con boundary",
            },
          },
          415,
        )
      }

      // 3. Validar content-length (límite local 25 MiB antes del proveedor)
      // 25 MiB = 25 * 1024 * 1024 = 26_214_400 bytes
      const contentLengthHeader = request.headers.get("content-length")
      const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader)
      if (
        contentLength !== null &&
        (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > 26_214_400)
      ) {
        return json(
          {
            error: {
              code: "UNSUPPORTED_MEDIA",
              message: "Archivo demasiado grande: límite 25 MiB",
            },
          },
          413,
        )
      }

      // 4. Configuración de seguridad requerida
      if (security.required) {
        if (!security.turnstile) {
          return json(
            {
              error: {
                code: "UPSTREAM_ERROR",
                message: "Configuración de seguridad incompleta.",
              },
            },
            502,
          )
        }
        if (!security.quota) {
          return json(
            {
              error: {
                code: "UPSTREAM_ERROR",
                message: "Configuración de seguridad incompleta.",
              },
            },
            502,
          )
        }
        if (security.ipHashSalt === null) {
          return json(
            {
              error: {
                code: "UPSTREAM_ERROR",
                message: "Configuración de seguridad incompleta.",
              },
            },
            502,
          )
        }
      }

      // 5. Turnstile verification
      const turnstileToken = request.headers.get("x-turnstile-token")
      const remoteIp = request.headers.get("cf-connecting-ip")

      if (security.turnstile) {
        const turnstileValid = await security.turnstile(turnstileToken, remoteIp)
        if (!turnstileValid) {
          return json(
            {
              error: {
                code: "UNAUTHORIZED",
                message: "No autorizado.",
              },
            },
            401,
          )
        }
      }

      // 6. Cuota (solo si hay configuración de quota)
      if (security.quota) {
        const salt = security.ipHashSalt
        if (!salt) {
          return json(
            {
              error: {
                code: "UPSTREAM_ERROR",
                message: "Configuración de seguridad incompleta.",
              },
            },
            502,
          )
        }
        let ipHash: string
        try {
          if (remoteIp) {
            ipHash = await hashIp(salt, remoteIp)
          } else {
            // Sin IP conectante → 429 sin llamar a Groq
            return json(
              {
                error: {
                  code: "QUOTA_EXCEEDED",
                  message: "Cuota diaria agotada; puedes usar el modo local.",
                },
              },
              429,
            )
          }
        } catch (_e: unknown) {
          // hashIp lanzó (salt vacío, IP inválida) → 502 sin Groq
          return json(
            {
              error: {
                code: "UPSTREAM_ERROR",
                message: "No se pudo verificar la cuota diaria.",
              },
            },
            502,
          )
        }

        try {
          const quotaResult = await consumeQuota(security.quota.store, ipHash, {
            limit: security.quota.limit,
          })
          if (!quotaResult.allowed) {
            return json(
              {
                error: {
                  code: "QUOTA_EXCEEDED",
                  message: "Cuota diaria agotada; puedes usar el modo local.",
                },
              },
              429,
            )
          }
        } catch (_e: unknown) {
          // consumeQuota lanzó → 502 sin Groq
          return json(
            {
              error: {
                code: "UPSTREAM_ERROR",
                message: "No se pudo verificar la cuota diaria.",
              },
            },
            502,
          )
        }
      }

      // 7. Llamada upstream a Groq
      // El signal del request: timeout de 120s combinado con abort del cliente
      const body = request.body
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120_000)])
      try {
        const result = await transcribeWithGroq(body, contentType, providerKey.trim(), signal)

        // 8. Mapeo de resultado
        if (result.ok) {
          const payload = result.payload

          // Groq devuelve `duration` en SEGUNDOS, convertir a ms
          let durationMs: number | undefined
          if (asRecord(payload) && typeof payload.duration === "number") {
            durationMs = Math.round(payload.duration * 1000)
          }

          const transcript = toTranscript(payload, durationMs)

          // Si toTranscript retorna null (no hay nada reconocible) → 502
          if (!transcript) {
            return json(
              {
                error: {
                  code: "UPSTREAM_ERROR",
                  message: "No se pudo reconocer el contenido de audio",
                },
              },
              502,
            )
          }

          return json(
            {
              segments: transcript.segments,
              language: transcript.language,
            },
            200,
          )
        }

        // Error del proveedor
        // Map: 401/403 → 401; 400/413/415/422 → 415; 429 → 429; anything else → 502
        const providerErrors: Record<number, { status: number; code: string; message: string }> = {
          401: { status: 401, code: "UNAUTHORIZED", message: "Clave inválida o no autorizada" },
          403: { status: 401, code: "UNAUTHORIZED", message: "Clave inválida o no autorizada" },
          400: { status: 415, code: "UNSUPPORTED_MEDIA", message: "Formato de audio no soportado" },
          413: { status: 415, code: "UNSUPPORTED_MEDIA", message: "Formato de audio no soportado" },
          415: { status: 415, code: "UNSUPPORTED_MEDIA", message: "Formato de audio no soportado" },
          422: { status: 415, code: "UNSUPPORTED_MEDIA", message: "Formato de audio no soportado" },
          429: { status: 429, code: "QUOTA_EXCEEDED", message: "Cuota agotada en Groq" },
        }

        const mapped = providerErrors[result.status] ?? {
          status: 502,
          code: "UPSTREAM_ERROR",
          message: "Error upstream del proveedor",
        }

        return json(
          {
            error: {
              code: mapped.code,
              message: mapped.message,
            },
          },
          mapped.status,
        )
      } catch (_err) {
        // Todos los errores se mapean a 502 UPSTREAM_ERROR
        return json(
          {
            error: {
              code: "UPSTREAM_ERROR",
              message: "Error al comunicarse con el proveedor de transcripción",
            },
          },
          502,
        )
      }
    },
    {
      detail: {
        tags: ["transcribe"],
        summary: "Proxy de transcripción a Groq con BYOK, Turnstile y cuota diaria",
        description:
          "Recibe un multipart/form-data y lo reenvía a la API de Groq usando la clave BYOK del usuario en x-provider-key, con verificación Turnstile y límite de cuota por IP",
      },
    },
  )

  return route
}
