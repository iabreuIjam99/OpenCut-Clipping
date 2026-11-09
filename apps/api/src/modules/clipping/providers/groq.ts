/**
 * Types locales para la transcripción (definidos en apps/api; no importar de apps/web).
 */

export interface TranscriptSegment {
  startMs: number
  endMs: number
  text: string
}

export interface TranscriptResult {
  segments: TranscriptSegment[]
  language: string
}

/**
 * Helper: safe versión de `payload` que garantiza `Record<string, unknown>` cuando
 * necesario, usando TypeScript narrowing en lugar de casts `as`.
 */
export function asRecord(pay: unknown): pay is Record<string, unknown> {
  return typeof pay === "object" && pay !== null
}

/**
 * Mapeo puro y defensivo de la respuesta `verbose_json` de Groq.
 *
 * - `startMs = Math.round(start * 1000)`, `endMs = Math.round(end * 1000)`.
 * - Si `duration` es finito y > 0: recorta ambos a `[0, durationMs]`.
 * - Descarta segmentos que no sean objeto, con `start`/`end` no finitos,
 *   o con `text` no string/vacío tras `trim()`. Ordena estable por `startMs`.
 * - `language`: el string no vacío de `payload.language`; si falta, `"und"`.
 * - Si no hay `segments` utilizables pero hay `text` no vacío: un único
 *   segmento `[0, durationMs]` (o `[0, 0]` si no hay duration válida).
 * - JSON válido pero forma irreconocible → retorna `null` (el caller decidirá `502`).
 * - Esta función nunca lanza por datos.
 * - Silencio no es error: `segments: []` y/o `text: ""` devuelve `{ segments, language }`.
 * - Solo retorna `null` si el payload no es un objeto o no contiene ni un array
 *   `segments` ni un string `text`.
 */
export function toTranscript(payload: unknown, durationMs?: number): TranscriptResult | null {
  // lenguaje: fallback "und"
  let language: string = "und"

  if (asRecord(payload)) {
    const lang = payload.language
    if (typeof lang === "string" && lang.trim().length > 0) {
      language = lang.trim()
    }
  }

  const segments: TranscriptSegment[] = []

  // Obtener segments del payload
  const rawSegments: unknown = asRecord(payload) ? payload.segments : undefined
  const segmentList: unknown[] = Array.isArray(rawSegments) ? rawSegments : []

  for (const seg of segmentList) {
    if (!asRecord(seg)) continue

    const start = seg.start
    const end = seg.end
    const text = seg.text

    // drop if start/end are not finite numbers
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < 0
    ) {
      continue
    }

    // drop if text is not a non-empty string after trim
    if (typeof text !== "string" || text.trim().length === 0) {
      continue
    }

    let startMs = Math.round(start * 1000)
    let endMs = Math.round(end * 1000)

    // clamp to duration if provided and finite > 0
    // durationMs already comes from Groq in seconds * 1000, so it's already in ms
    if (durationMs !== undefined && durationMs > 0) {
      startMs = Math.max(0, Math.min(startMs, durationMs))
      endMs = Math.max(startMs, Math.min(endMs, durationMs))
    }

    // enforce start <= end unconditionally
    if (endMs < startMs) endMs = startMs

    segments.push({ startMs, endMs, text: text.trim() })
  }

  // stable sort by startMs
  segments.sort((a, b) => a.startMs - b.startMs)

  // Si no hay segments utilizables pero hay text no vacío en el payload raíz,
  // un único segmento [0, durationMs] (o [0, 0] si no hay duration válida).
  if (segments.length === 0 && asRecord(payload)) {
    const rawText = payload.text ?? payload.transcript ?? undefined

    if (typeof rawText === "string" && rawText.trim().length > 0 && durationMs !== undefined) {
      segments.push({ startMs: 0, endMs: durationMs, text: rawText.trim() })
    } else if (
      typeof rawText === "string" &&
      rawText.trim().length > 0 &&
      durationMs === undefined
    ) {
      segments.push({ startMs: 0, endMs: 0, text: rawText.trim() })
    }
  }

  // Si el payload no es un objeto, retornar null (payload irreconocible)
  if (!asRecord(payload)) {
    return null
  }

  // Determinar si el payload tiene contenido reconocible:
  // - un array `segments` (aunque esté vacío) o
  // - una string `text` o `transcript` (aunque esté vacía)
  // Solo retornar null si realmente no hay ni segments ni text en absoluto.
  const hasSegmentsArray = Array.isArray(payload.segments)
  const hasTextString = typeof payload.text === "string" || typeof payload.transcript === "string"

  if (!hasSegmentsArray && !hasTextString) {
    return null
  }

  return { segments, language }
}

/**
 * Transcribe audio usando la API de Groq.
 *
 * body: ReadableStream a enviar
 * contentType: Content-Type del request (multipart/form-data con boundary)
 * key: API key de Groq (Authorization: Bearer <key>)
 * signal: AbortSignal para timeout/abort
 */
export async function transcribeWithGroq(
  body: ReadableStream | null,
  contentType: string,
  key: string,
  signal: AbortSignal,
): Promise<{ ok: true; payload: unknown } | { ok: false; status: number }> {
  const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions"

  const headers = new Headers({
    Authorization: `Bearer ${key}`,
    "Content-Type": contentType,
    Accept: "application/json",
  })

  const response = await fetch(GROQ_TRANSCRIPTIONS_URL, {
    method: "POST",
    headers,
    body: body ?? undefined,
    redirect: "manual",
    signal,
  })

  if (!response.ok) {
    return { ok: false, status: response.status }
  }

  try {
    const payload = await response.json()
    return { ok: true, payload }
  } catch {
    // JSON parse error - the caller (route) will map this to 502
    throw new Error("JSON parse error")
  }
}
