/**
 * Heurísticas locales de corte deterministas y sin red.
 *
 * Convierte un `TranscriptSegment[]` + un *brief* del usuario en `ClipCandidate[]`
 * válidos, puntuados y sin solapes. La firma es tipada; las pruebas pueden invocarla
 * pasando `unknown` mediante un wrapper guard tipo-local (sin `as`).
 *
 * @module local-cuts
 */

/* ---- Valores espejo de apps/api/src/modules/clipping/contracts.ts ----
 * MIN_CLIP_MS = 15_000
 * MAX_CLIP_MS = 180_000
 * MAX_CLIPS = 20
 * MAX_TITLE_LENGTH = 80
 * SNAP_MS = 750
 * TARGET_WINDOW_MS = 60_000
 * ------------------------------- */

const MIN_CLIP_MS = 15_000
const MAX_CLIP_MS = 180_000
const MAX_CLIPS = 20
const MAX_TITLE_LENGTH = 80
const SNAP_MS = 750
const TARGET_WINDOW_MS = 60_000

/** Idéntico a `apps/api/src/modules/clipping/contracts.ClipCandidate` */
export type ClipCandidate = {
  readonly id: string
  readonly startMs: number
  readonly endMs: number
  readonly title: string
  readonly score: number
}

import type { TranscriptSegment } from "../media/transcript"

/** Valida que un valor `unknown` sea un segmento de transcripción válido.
 *  Usa el operador `in` para el narrowing de TypeScript — sin `as`, sin casts.
 *  Acepta `startMs: 0` como valor válido (a diferencia de las versiones anteriores
 *  que lo rechazaban por considerar `0` como falso).
 */
function isTranscriptSegment(value: unknown): value is TranscriptSegment {
  if (typeof value !== "object" || value === null) return false
  if (!("startMs" in value) || !("endMs" in value) || !("text" in value)) return false
  return (
    typeof value.startMs === "number" &&
    Number.isFinite(value.startMs) &&
    typeof value.endMs === "number" &&
    Number.isFinite(value.endMs) &&
    typeof value.text === "string"
  )
}

/** Tokeniza un string en keywords: minúsculas, NFD + quitar marcas combinantes,
 *  partición por no-\p{L}/\p{N}, descartar < 3 y stopwords, deduplicar, primeras 24. */
function tokenizeKeywords(text: string): string[] {
  // NFD + eliminar marcas combinantes (\p{M})
  let normalized = text.normalize("NFD")
  normalized = normalized.replace(/\p{M}/gu, "")

  // minúsculas y partición
  const lower = normalized.toLocaleLowerCase("es")
  const parts = lower.split(/[^\p{L}\p{N}]/u)

  const stopwords = new Set([
    "que",
    "como",
    "para",
    "pero",
    "este",
    "esta",
    "esto",
    "los",
    "las",
    "del",
    "con",
    "por",
    "una",
    "uno",
    "the",
    "and",
    "for",
    "with",
    "this",
    "that",
    "from",
    "you",
    "your",
    "are",
    "was",
    "have",
  ])

  const result: string[] = []
  const seen = new Set<string>()
  for (const p of parts) {
    if (p.length < 3) continue
    if (stopwords.has(p)) continue
    if (seen.has(p)) continue
    seen.add(p)
    result.push(p)
    if (result.length >= 24) break
  }
  return result
}

/** Cuenta preguntas: segmento cuyo texto contiene `?` o empieza por palabra interrogativa. */
function countQuestions(segments: TranscriptSegment[]): number {
  const interrogativas = new Set([
    "que",
    "como",
    "porque",
    "cuando",
    "donde",
    "quien",
    "cual",
    "cuanto",
    "what",
    "how",
    "why",
    "when",
    "where",
    "who",
    "which",
  ])

  let count = 0
  for (const seg of segments) {
    const t = seg.text
    // Count `?` first and skip to avoid double counting
    if (t.includes("?")) {
      count++
      continue
    }
    // Normalize: NFD + quitar marcas combinantes, minúsculas, quitar punc inicial
    let normalized = t.normalize("NFD")
    normalized = normalized.replace(/\p{M}/gu, "")
    normalized = normalized.toLocaleLowerCase("es")
    // Strip leading punctuation/whitespace: ¿ ¡ " " " " ' ( [ y whitespace
    normalized = normalized.replace(/^[¿¡"“'(\s]+/u, "")
    const firstWord = normalized.split(/\s+/u)[0]
    if (interrogativas.has(firstWord)) {
      count++
    }
  }
  return count
}

/** Señal de números: dígitos con posible decimal, tope 10. */
function countNumbers(segments: TranscriptSegment[]): number {
  let total = 0
  for (const seg of segments) {
    const matches = seg.text.match(/\d(?:[.,]\d+)?/gu) || []
    total += matches.length
  }
  return Math.min(10, total)
}

/** Saturation helper: sat(x, objetivo) = Math.min(1, x / objetivo) */
function sat(x: number, objetivo: number): number {
  return Math.min(1, x / objetivo)
}

/** Normaliza y valida un segmento de entrada que viene como `unknown`.
 *  Retorna `undefined` si el segmento no es válido; nunca lanza.
 */
function normalizeSegment(raw: unknown): TranscriptSegment | undefined {
  if (!isTranscriptSegment(raw)) return undefined
  const startMs = Math.round(raw.startMs)
  const endMs = Math.round(raw.endMs)
  if (endMs <= startMs) return undefined
  if (startMs < 0) return undefined
  const text = raw.text.trim()
  if (text === "") return undefined
  return { startMs, endMs, text }
}

/** Construye ventanas base de corte de forma determinista y sin solapes.
 *  - Avance por cursor: después de emitir una ventana, el cursor salta al
 *    primer segmento con startMs >= winEnd (evita doble-counting).
 *  - Cap hard: 180 s (MAX_CLIP_MS), mínima 15 s (MIN_CLIP_MS).
 *  - Ventana objetivo ~60 s (TARGET_WINDOW_MS): incluye segmentos consecutivos
 *    hasta que fin - inicio >= TARGET_WINDOW_MS o el siguiente excedería MAX_CLIP_MS.
 *  - Una segmento anómalo > MAX_CLIP_MS descarte y corta el bucle inmediatamente.
 *  - Cola corta (< MIN_CLIP_MS) se descarta al final.
 *  - Solapes: los segmentos que superan la frontera de la ventana emitida se saltean.
 */
function buildWindows(
  normalized: TranscriptSegment[],
): Array<{ startMs: number; endMs: number; segments: TranscriptSegment[] }> {
  const windows: Array<{ startMs: number; endMs: number; segments: TranscriptSegment[] }> = []
  let cursor = 0

  while (cursor < normalized.length) {
    const startMs = normalized[cursor].startMs
    let endIdx = cursor
    let winEnd = normalized[endIdx].endMs

    // Incorporar segmentos consecutivos hasta el techo MAX o el target TARGET
    while (endIdx + 1 < normalized.length) {
      const nextEnd = normalized[endIdx + 1].endMs
      if (nextEnd - startMs > MAX_CLIP_MS) break // segmento anómalo > 180 s: descarte inmediato
      endIdx += 1
      winEnd = nextEnd
      if (winEnd - startMs >= TARGET_WINDOW_MS) break // alcanzamos ~60 s: ya podemos cortar
    }

    const duration = winEnd - startMs
    // Guardar ventana solo si cumple el mínimo
    if (duration >= MIN_CLIP_MS && duration <= MAX_CLIP_MS) {
      windows.push({
        startMs,
        endMs: winEnd,
        segments: normalized.slice(cursor, endIdx + 1),
      })
    }

    // Avanzar cursor: saltar al primer segmento que no se superpone con la ventana emitida
    let next = endIdx + 1
    while (next < normalized.length && normalized[next].startMs < winEnd) {
      next += 1
    }
    cursor = next
  }

  return windows
}

/** Snapping interno: ajusta start/end a la frontera más cercana dentro de SNAP_MS.
 *  Valida el resultado contra el `span` total para no invadir límites.
 *  Exportado para reutilización por el camino LLM (Task 17), cuyas cortes
 *  pueden tener bordes que no sean alineados a segmentos; para los windows
 *  producidos por scoreWindows este es un no-op (distancia 0), pero el helper
 *  está preparado para aplicar snap y validar MIN/MAX/span.
 */
export function snapToBoundaries(
  startMs: number,
  endMs: number,
  boundaries: ReadonlyArray<number>,
  span: number,
): { startMs: number; endMs: number } {
  let newStart = startMs
  let newEnd = endMs

  // Snapping de inicio: frontera más cercana con |frontera - startMs| <= SNAP_MS;
  // en empate, la menor.
  let bestStartIdx = -1
  let bestStartDist = Infinity
  for (let i = 0; i < boundaries.length; i++) {
    const d = Math.abs(boundaries[i] - startMs)
    if (d < bestStartDist || (d === bestStartDist && boundaries[i] < boundaries[bestStartIdx])) {
      bestStartDist = d
      bestStartIdx = i
    }
  }
  if (bestStartDist <= SNAP_MS) {
    newStart = boundaries[bestStartIdx]
  }

  // Snapping de fin: ídem.
  let bestEndIdx = -1
  let bestEndDist = Infinity
  for (let i = 0; i < boundaries.length; i++) {
    const d = Math.abs(boundaries[i] - endMs)
    if (d < bestEndDist || (d === bestEndDist && boundaries[i] < boundaries[bestEndIdx])) {
      bestEndDist = d
      bestEndIdx = i
    }
  }
  if (bestEndDist <= SNAP_MS) {
    newEnd = boundaries[bestEndIdx]
  }

  // Validar después del snap: start >= 0, duración en [MIN, MAX], fin <= span
  if (
    newStart >= 0 &&
    newEnd - newStart >= MIN_CLIP_MS &&
    newEnd - newStart <= MAX_CLIP_MS &&
    newEnd <= span
  ) {
    return { startMs: newStart, endMs: newEnd }
  }
  return { startMs: startMs, endMs: endMs }
}

/** Puntuación determinista de ventanas de corte.
 *  Nunca lanza: todo el cuerpo está en try/catch y retorna [] en catch.
 *  Misma entrada → misma salida byte a byte, incluso si el input está reordenado.
 *  Firma: scoreWindows(segments: readonly unknown[], brief: string): ClipCandidate[]
 */
export function scoreWindows(segments: unknown, brief: unknown): ClipCandidate[] {
  try {
    // ---- Type validation without `any` ----
    if (!Array.isArray(segments)) return []
    if (typeof brief !== "string") return []

    // Normalizar cada segmento (filter + map, sin mutar el input original)
    const normalized: TranscriptSegment[] = []
    for (const seg of segments) {
      const n = normalizeSegment(seg)
      if (n !== undefined) normalized.push(n)
    }

    // Ordenar por startMs ascendente, luego endMs ascendente (garantiza determinismo reordenado)
    normalized.sort((a, b) => {
      if (a.startMs !== b.startMs) return a.startMs - b.startMs
      return a.endMs - b.endMs
    })

    // Filtrar por span mínimo
    if (normalized.length === 0) return []
    const span = normalized[normalized.length - 1].endMs
    if (span < MIN_CLIP_MS) return []

    // ---- 2. Ventanas base ----
    const windows = buildWindows(normalized)

    // ---- 3. Snapping ±SNAP_MS ----
    // Fronteras candidatas = todos los startMs y endMs de los segmentos normalizados
    const allBoundaries: number[] = []
    for (const seg of normalized) {
      allBoundaries.push(seg.startMs)
      allBoundaries.push(seg.endMs)
    }

    const clippedWindows: Array<{
      startMs: number
      endMs: number
      segments: TranscriptSegment[]
      title: string
      score: number
    }> = []

    for (const win of windows) {
      const { startMs: snappedStart, endMs: snappedEnd } = snapToBoundaries(
        win.startMs,
        win.endMs,
        allBoundaries,
        span,
      )

      const duration = snappedEnd - snappedStart
      if (snappedStart < 0) continue
      if (duration < MIN_CLIP_MS || duration > MAX_CLIP_MS) continue
      if (snappedEnd > span) continue

      // Título: texto del primer segmento, saneado
      const firstSeg = win.segments[0]
      let title = firstSeg.text
      // Colapsar espacios
      title = title.replace(/\s+/g, " ").trim()
      // Eliminar caracteres de control C0 y 0x7f y < > (texto plano, nunca HTML)
      // Usamos loop en lugar de regex con caracteres de control para evitar lint
      let clean = ""
      for (let i = 0; i < title.length; i++) {
        const code = title.charCodeAt(i)
        if (code >= 0x20 && code !== 0x7f && code !== 0x3c && code !== 0x3e) {
          clean += title[i]
        }
      }
      title = clean
      // Truncar a MAX_TITLE_LENGTH code points
      if (Array.from(title).length > MAX_TITLE_LENGTH) {
        title = Array.from(title).slice(0, MAX_TITLE_LENGTH).join("")
      }
      title = title.trim()

      if (title === "") {
        // Fallback mm:mm (corregido: minutos desde snappedStart, no del módulo)
        const minutes = Math.floor(snappedStart / TARGET_WINDOW_MS)
        const seconds = Math.floor((snappedStart % TARGET_WINDOW_MS) / 1_000)
        title = `Clip ${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      }

      // ---- 4. Scoring ----
      // Normalizar texto de la ventana: unir con espacio, NFD + quitar marcas combinantes
      const normalizedText = win.segments
        .map((s) => s.text)
        .join(" ")
        .toLocaleLowerCase("es")
        .normalize("NFD")
        .replace(/\p{M}/gu, "")

      const questions = countQuestions(win.segments)
      const numbers = countNumbers(win.segments)

      // Tokenizar brief con el mismo pipeline y contar OCCURRENCES (no solo set membership)
      const briefTokens = tokenizeKeywords(brief)

      let keywords = 0
      if (briefTokens.length > 0) {
        // Para cada keyword, contar apariciones con frontera de palabra (\b) en el texto normalizado
        for (const token of briefTokens) {
          const regex = new RegExp(`\\b${token}\\b`, "gu")
          const matches = normalizedText.match(regex)
          if (matches) {
            keywords += matches.length
          }
        }
        keywords = Math.min(10, keywords)
      }

      // Score bruto, con sat(x, objetivo) = Math.min(1, x / objetivo):
      // score = 0.5 * sat(keywords, 3) + 0.3 * sat(questions, 2) + 0.2 * sat(numbers, 4)
      const rawScore = 0.5 * sat(keywords, 3) + 0.3 * sat(questions, 2) + 0.2 * sat(numbers, 4)
      const roundedScore = Math.round(rawScore * 10_000) / 10_000

      clippedWindows.push({
        startMs: snappedStart,
        endMs: snappedEnd,
        segments: win.segments,
        title,
        score: roundedScore,
      })
    }

    // ---- 5. Selección final ----
    // Descartar candidatos inválidos
    const validCandidates: ClipCandidate[] = []
    for (const c of clippedWindows) {
      if (c.startMs >= 0 && c.endMs > c.startMs) {
        const dur = c.endMs - c.startMs
        if (dur >= MIN_CLIP_MS && dur <= MAX_CLIP_MS && Number.isFinite(c.score)) {
          if (c.title.length > 0) {
            validCandidates.push({
              id: `clip-${c.startMs}-${c.endMs}`,
              startMs: c.startMs,
              endMs: c.endMs,
              title: c.title,
              score: c.score,
            })
          }
        }
      }
    }

    // Ordenar por score descendente; empate → startMs ascendente
    validCandidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.startMs - b.startMs
    })

    // Voraz sin solapes: a.startMs < b.endMs && b.startMs < a.endMs
    const accepted: ClipCandidate[] = []
    for (const cand of validCandidates) {
      if (accepted.length >= MAX_CLIPS) break
      const conflicts = accepted.some(
        (existing) => cand.startMs < existing.endMs && existing.startMs < cand.endMs,
      )
      if (!conflicts) accepted.push(cand)
    }

    // Devolver ordenado por startMs ascendente
    return accepted.sort((a, b) => a.startMs - b.startMs)
  } catch {
    return []
  }
}
