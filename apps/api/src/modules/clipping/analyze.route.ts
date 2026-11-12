import { Elysia } from "elysia"
import { validateCuts } from "./cut-validator"
import type { TranscriptSegment } from "./providers/groq"
import { asRecord } from "./providers/groq"
import type { AiBinding, AnalyzeInput } from "./providers/workers-ai"
import { analyzeWithWorkersAi } from "./providers/workers-ai"
import { consumeQuota, hashIp } from "./quota"
import type { RuntimeSecurity } from "./transcribe.route"

function json(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  })
}

/** Tope por segmento: el prompt recorta a 24 000 caracteres en total. */
const MAX_SEGMENT_CHARS = 2_000

/** Elimina caracteres de control C0 y `0x7f` conservando code points completos. */
function stripControlChars(value: string): string {
  let out = ""
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x20 && code !== 0x7f) out += char
  }
  return out
}

export type AnalyzeRouteOptions = {
  security: RuntimeSecurity
  ai: AiBinding | null
}

/**
 * `POST /v1/analyze` — análisis opcional de cortes con Workers AI.
 *
 * Contrato:
 * - Orden de guardas: configuración → binding `AI` → Turnstile → cuota →
 *   cuerpo → LLM. Cualquier fallo anterior al LLM devuelve un error tipado y
 *   **no invoca el binding**.
 * - La cuota se consume **antes** del LLM y no se devuelve si el LLM falla:
 *   es deliberado, para que un atacante no pueda sondear el proveedor gratis.
 * - La salida pasa siempre por `validateCuts`; es la única fuente de verdad de
 *   la forma de los cortes.
 * - El servidor **no** aplica snapping: `snapToBoundaries` vive en el cliente
 *   (Task 19b), que alinea los cortes con las fronteras de segmento.
 * - `INVALID_REQUEST` (400) es específico de esta ruta: el cuerpo no es JSON,
 *   no es un objeto, o sus campos no cumplen el contrato.
 * - Fallback cliente-first: cualquier fallo del LLM devuelve `200 { cuts: [] }`;
 *   el cliente conserva sus heurísticas locales.
 */
export function createAnalyzeRoute(options: AnalyzeRouteOptions) {
  const { security, ai } = options

  const route = new Elysia({ name: "clipping.analyze" }).post(
    "/v1/analyze",
    async ({ request }) => {
      // --- 1. Configuración de seguridad ---
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

      // --- 2. Binding `AI` presente ---
      if (!ai) {
        return json(
          {
            error: {
              code: "UPSTREAM_ERROR",
              message: "Servicio de análisis no disponible.",
            },
          },
          502,
        )
      }

      // --- 3. Turnstile verification ---
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

      // --- 4. Cuota ---
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

      // --- 5. Parseo y validación del cuerpo ---
      let input: unknown
      try {
        const raw = await request.json()
        input = raw
      } catch {
        return json(
          {
            error: {
              code: "INVALID_REQUEST",
              message: "Cuerpo de petición inválido.",
            },
          },
          400,
        )
      }

      // Validar content-type application/json (case-insensitive)
      const contentType = request.headers.get("content-type") ?? ""
      const lowerContentType = contentType.toLowerCase()
      if (!lowerContentType.includes("application/json")) {
        return json(
          {
            error: {
              code: "INVALID_REQUEST",
              message: "Cuerpo de petición debe ser application/json.",
            },
          },
          400,
        )
      }

      // Validar que el cuerpo no es un array y cumple el predicado asRecord
      // Un array también es un objeto: se descarta explícitamente antes del predicado.
      if (Array.isArray(input) || !asRecord(input)) {
        return json(
          {
            error: {
              code: "INVALID_REQUEST",
              message: "Cuerpo debe ser un objeto JSON.",
            },
          },
          400,
        )
      }

      // `asRecord` es un predicado de tipo: aquí no hace falta ninguna aserción.
      const body = input

      // Validar segments
      const segmentsRaw = body.segments
      if (!Array.isArray(segmentsRaw)) {
        return json(
          {
            error: {
              code: "INVALID_REQUEST",
              message: "Segments debe ser un array.",
            },
          },
          400,
        )
      }

      // Tope duro 1..5000: sin él, un array arbitrario se recorre antes de validar.
      if (segmentsRaw.length < 1 || segmentsRaw.length > 5_000) {
        return json(
          {
            error: {
              code: "INVALID_REQUEST",
              message: "Segments debe tener entre 1 y 5000 elementos.",
            },
          },
          400,
        )
      }

      // Filtrar segmentos inválidos
      const validSegments: TranscriptSegment[] = []
      for (const seg of segmentsRaw) {
        if (
          typeof seg !== "object" ||
          seg === null ||
          !("startMs" in seg) ||
          !("endMs" in seg) ||
          !("text" in seg)
        ) {
          continue
        }
        if (typeof seg.startMs !== "number" || !Number.isFinite(seg.startMs)) continue
        if (typeof seg.endMs !== "number" || !Number.isFinite(seg.endMs)) continue
        if (typeof seg.text !== "string") continue

        // Redondear PRIMERO: 0.6..0.8 colapsa a 1..1 y debe descartarse,
        // igual que `normalizeSegment` en `local-cuts.ts`.
        const startMs = Math.round(seg.startMs)
        const endMs = Math.round(seg.endMs)
        if (startMs < 0 || endMs <= startMs) continue

        const text = seg.text.trim()
        if (text.length === 0) continue

        // Recorte por segmento sin partir pares surrogados. Sin este tope, un
        // `text` de megabytes se amplifica al neutralizarlo y al unir el prompt.
        const cappedText =
          text.length <= MAX_SEGMENT_CHARS
            ? text
            : Array.from(text).slice(0, MAX_SEGMENT_CHARS).join("")

        validSegments.push({ startMs, endMs, text: cappedText })
      }

      // Si después de filtrar no queda ningún segmento válido → 400
      if (validSegments.length === 0) {
        return json(
          {
            error: {
              code: "INVALID_REQUEST",
              message: "No hay segmentos válidos.",
            },
          },
          400,
        )
      }

      // Validar durationMs: entero finito en [1, 86_400_000]
      const durationMsRaw = body.durationMs
      if (
        typeof durationMsRaw !== "number" ||
        !Number.isFinite(durationMsRaw) ||
        !Number.isInteger(durationMsRaw) ||
        durationMsRaw < 1 ||
        durationMsRaw > 86_400_000
      ) {
        return json(
          {
            error: {
              code: "INVALID_REQUEST",
              message: "durationMs debe ser un entero finito en [1, 86400000].",
            },
          },
          400,
        )
      }

      // Validar brief: string, quitar controles, recortar, y solo entonces contar code points.
      // Si se contara antes, un brief de solo caracteres de control pasaría el filtro y llegaría vacío al modelo.
      const briefRaw = body.brief
      if (typeof briefRaw !== "string") {
        return json(
          {
            error: {
              code: "INVALID_REQUEST",
              message: "brief debe ser un string.",
            },
          },
          400,
        )
      }

      // Cota barata antes de limpiar: cada code point ocupa como máximo dos
      // unidades UTF-16, así que más de 1 000 unidades no puede caber en 500
      // code points. Evita recorrer un brief de megabytes.
      if (briefRaw.length > 1_000) {
        return json(
          {
            error: {
              code: "INVALID_REQUEST",
              message: "brief debe tener entre 1 y 500 code points.",
            },
          },
          400,
        )
      }

      // Orden: quitar controles, recortar, y solo luego contar code points.
      // Si se contara antes, un brief de solo caracteres de control pasaría
      // el filtro y llegaría vacío al modelo.
      const briefClean = stripControlChars(briefRaw).trim()
      const briefLength = Array.from(briefClean).length
      if (briefLength < 1 || briefLength > 500) {
        return json(
          {
            error: {
              code: "INVALID_REQUEST",
              message: "brief debe tener entre 1 y 500 code points.",
            },
          },
          400,
        )
      }

      // --- 6. Llamada al LLM ---
      const analyzeInput: AnalyzeInput = {
        segments: validSegments,
        brief: briefClean,
        durationMs: durationMsRaw,
      }

      // `analyzeWithWorkersAi` nunca lanza: devuelve `null` en timeout o excepción.
      const extracted = await analyzeWithWorkersAi(ai, analyzeInput)

      // Si el LLM devolvió null o sin cuts → 200 { cuts: [] }
      if (!asRecord(extracted)) {
        return json({ cuts: [] }, 200)
      }

      const cutsRaw = extracted.cuts
      if (!Array.isArray(cutsRaw)) {
        return json({ cuts: [] }, 200)
      }

      // --- 7. validateCuts (única fuente de verdad de la salida) ---
      const durationMedia = { durationMs: durationMsRaw }
      const validatedCuts = validateCuts(cutsRaw, durationMedia)

      // Always return 200 with validated cuts (could be empty)
      return json({ cuts: validatedCuts }, 200)
    },
    {
      detail: {
        tags: ["clipping"],
        summary: "Análisis opcional de cortes con Workers AI",
        description:
          "Recibe segments, brief y durationMs; valida seguridad, Turnstile y cuota antes de llamar al LLM. Fallback cliente-first: cualquier fallo del LLM devuelve 200 { cuts: [] }.",
      },
    },
  )

  return route
}
