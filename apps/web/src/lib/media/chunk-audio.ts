/**
 * Audio segmentation for the cloud pipeline (Task 11, ARCHITECTURE §4.3).
 *
 * The pure half ({@link planChunks}, {@link mergeTranscripts}) never touches
 * ffmpeg, so jsdom exercises it directly. The real cutter ({@link chunkAudio})
 * reuses the Task 10 runtime: jsdom cannot execute the WASM core, hence the
 * injected `cut` (tests) and the injected `runtime` (same seam as
 * `extract-audio.ts`).
 *
 * Contract:
 * - The total duration is read from the container with `probeMatroska`
 *   (Task 9): never hardcoded, never estimated from bytes.
 * - The cutter mounts the source ONCE with WORKERFS under `audio.webm` and
 *   stream-copies every range with `-c copy` (no re-encode): slicing a WebM
 *   stream by bytes would produce undecodable chunks, so the cut is temporal.
 * - Cleanup (`unmount`, both `deleteDir`, `terminate`) runs in `finally`; each
 *   step tolerates its own failure so it never masks the result or the error,
 *   and `terminate()` runs on every path.
 * - Failures surface as the generic Spanish {@link ChunkingError}; the
 *   technical detail only reaches `console.error` in development.
 *
 * @module chunk-audio
 */

import { probeMatroska } from "../clipping/media-guard"
import { type AudioExtractionRuntime, createFfmpegRuntime } from "./ffmpeg-runtime"
import type { TranscriptSegment } from "./transcript"

export type AudioChunk = { blob: Blob; offsetMs: number }

export type ChunkRange = { startMs: number; endMs: number }

export type ChunkAudioOptions = {
  maxBytes: number
  overlapMs: number
  /** Solo tests: corta [startMs, endMs) del fuente. */
  cut?: (source: Blob, startMs: number, endMs: number) => Promise<Blob>
  /** Solo tests: runtime inyectado para el cortador por defecto. */
  runtime?: AudioExtractionRuntime
}

/** Generic, Spanish, detail-free error surfaced to the caller (R2.4). */
export class ChunkingError extends Error {
  readonly code: "UNSUPPORTED_AUDIO"

  constructor() {
    super("No se pudo segmentar el audio.")
    this.name = "ChunkingError"
    this.code = "UNSUPPORTED_AUDIO"
  }
}

/** Fixed WORKERFS paths and command (R2.3). */
const INPUT_PATH = "/input"
const SOURCE_PATH = "/input/audio.webm"
const OUTPUT_DIR = "/output"
const OUTPUT_PATH = "/output/chunk.webm"

const CUT_ARGS = (startMs: number, endMs: number): readonly string[] => [
  "-ss",
  String(startMs / 1000),
  "-i",
  SOURCE_PATH,
  "-t",
  String((endMs - startMs) / 1000),
  "-c",
  "copy",
  "-f",
  "webm",
  OUTPUT_PATH,
]

/** Cota dura de rangos planificados (simétrica con MAX_ITERATIONS de Task 9). */
const MAX_CHUNKS = 10_000

const TEMPORAL_DUPLICATE_MS = 250
const SIMILARITY_WINDOW_MS = 2500
const SIMILARITY_THRESHOLD = 0.8
const MAX_OVERLAP_SEGMENTS = 5

/**
 * Plans temporal ranges of at most `maxBytes` with an exact `overlapMs`
 * overlap, purely from the measured `bytes / durationMs` density (R1).
 *
 * @throws {ChunkingError} on invalid inputs or a limit too small for the overlap.
 */
export function planChunks(input: {
  durationMs: number
  bytes: number
  maxBytes: number
  overlapMs: number
}): ChunkRange[] {
  const { durationMs, bytes, maxBytes, overlapMs } = input
  // Los no finitos atraviesan las comparaciones de signo (NaN <= 0 es falso)
  // y dejaban el bucle de planificación sin terminar: se rechazan primero.
  if (
    !Number.isFinite(durationMs) ||
    !Number.isFinite(bytes) ||
    !Number.isFinite(maxBytes) ||
    !Number.isFinite(overlapMs) ||
    durationMs <= 0 ||
    bytes <= 0 ||
    maxBytes <= 0 ||
    overlapMs < 0
  ) {
    throw new ChunkingError()
  }

  const bytesPerMs = bytes / durationMs
  const chunkMs = Math.floor(maxBytes / bytesPerMs)
  if (!Number.isFinite(chunkMs) || chunkMs <= 0 || chunkMs <= overlapMs * 2) {
    throw new ChunkingError()
  }

  const ranges: ChunkRange[] = []
  let start = 0
  for (;;) {
    // Cada iteración añade exactamente un rango: la cota garantiza terminación
    // para cualquier entrada admitida (evita el estancamiento IEEE-754).
    if (ranges.length >= MAX_CHUNKS) throw new ChunkingError()
    const end = Math.min(start + chunkMs, durationMs)
    ranges.push({ startMs: start, endMs: end })
    if (end >= durationMs) break
    start = end - overlapMs
  }
  return ranges
}

/** Reads the container duration; any probe failure or result is generic. */
async function probeDurationMs(blob: Blob): Promise<number> {
  const probe = await probeMatroska(blob).catch((error: unknown) => {
    if (import.meta.env.DEV) {
      // biome-ignore lint/suspicious/noConsole: dev-only diagnostic, never exposed to the user
      console.error("[chunk-audio] sonda de contenedor fallida", error)
    }
    return null
  })

  if (
    probe === null ||
    probe.container === "unknown" ||
    !Number.isFinite(probe.durationMs) ||
    probe.durationMs <= 0
  ) {
    throw new ChunkingError()
  }
  return probe.durationMs
}

/**
 * Cuts every range with ONE mount of the source and stream copy (R2.3).
 * The output is dropped after each read so `/output` is empty for cleanup.
 */
async function cutWithRuntime(
  blob: Blob,
  ranges: ChunkRange[],
  runtime: AudioExtractionRuntime,
): Promise<AudioChunk[]> {
  const chunks: AudioChunk[] = []
  try {
    await runtime.load()
    // Emscripten exige que exista el punto de montaje (spike de Task 6).
    await runtime.createDir(INPUT_PATH)
    const source = new File([blob], "audio.webm")
    const mounted = await runtime.mount(source, INPUT_PATH)
    if (!mounted) throw new Error("WORKERFS no disponible en el montaje")
    await runtime.createDir(OUTPUT_DIR)

    for (const range of ranges) {
      const exitCode = await runtime.exec(CUT_ARGS(range.startMs, range.endMs))
      if (exitCode !== 0) throw new Error(`ffmpeg devolvió exit code ${exitCode}`)

      const data = await runtime.readFile(OUTPUT_PATH)
      if (typeof data === "string") throw new Error("la salida no es un buffer binario")

      chunks.push({
        blob: new Blob([new Uint8Array(data)], { type: "audio/webm" }),
        offsetMs: range.startMs,
      })
      await runtime.deleteFile(OUTPUT_PATH)
    }
    return chunks
  } finally {
    // Orden R2.3; cada paso tolera su propio fallo sin enmascarar el resultado.
    try {
      await runtime.unmount(INPUT_PATH)
    } catch {
      /* no estaba montado */
    }
    try {
      await runtime.deleteDir(INPUT_PATH)
    } catch {
      /* ya no existe */
    }
    try {
      await runtime.deleteDir(OUTPUT_DIR)
    } catch {
      /* ya no existe */
    }
    try {
      runtime.terminate()
    } catch {
      /* el worker ya no existe */
    }
  }
}

/**
 * Segments `blob` into time ranges of at most `maxBytes` with `overlapMs` of
 * overlap. The duration comes from `probeMatroska`; the cut is temporal
 * (`-c copy`) and never rewrites the source.
 *
 * @throws {ChunkingError} always, with a generic Spanish message (R2.4).
 */
export async function chunkAudio(blob: Blob, opts: ChunkAudioOptions): Promise<AudioChunk[]> {
  const durationMs = await probeDurationMs(blob)
  const ranges = planChunks({
    durationMs,
    bytes: blob.size,
    maxBytes: opts.maxBytes,
    overlapMs: opts.overlapMs,
  })

  const cut = opts.cut
  try {
    if (cut) {
      const chunks: AudioChunk[] = []
      for (const range of ranges) {
        chunks.push({ blob: await cut(blob, range.startMs, range.endMs), offsetMs: range.startMs })
      }
      return chunks
    }
    return await cutWithRuntime(blob, ranges, opts.runtime ?? createFfmpegRuntime())
  } catch (error) {
    if (import.meta.env.DEV) {
      // biome-ignore lint/suspicious/noConsole: dev-only diagnostic, never exposed to the user
      console.error("[chunk-audio] segmentacion fallida", error)
    }
    throw new ChunkingError()
  }
}

/** Lowercase, de-accented, `[a-z0-9]`-only, single-spaced, trimmed (R3). */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function tokens(text: string): Set<string> {
  return new Set(text.split(" ").filter((token) => token.length > 0))
}

/** Jaccard similarity of the token sets; empty sets score 0 (R3). */
function jaccard(a: string, b: string): number {
  const left = tokens(a)
  const right = tokens(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) {
    if (right.has(token)) shared++
  }
  return shared / (left.size + right.size - shared)
}

/**
 * Merges per-chunk transcripts given in ABSOLUTE times (the caller sums
 * `AudioChunk.offsetMs` first): drops temporal duplicates, deduplicates the
 * overlap by normalized Jaccard ≥ 0.8 inside a 2500 ms window, keeps later
 * legitimate repetitions, sorts stably by `startMs` and drops empty text (R3).
 */
export function mergeTranscripts(chunks: TranscriptSegment[][]): TranscriptSegment[] {
  const ordered = [...chunks].sort((a, b) => (a[0]?.startMs ?? 0) - (b[0]?.startMs ?? 0))
  const merged: TranscriptSegment[] = []

  for (const chunk of ordered) {
    if (merged.length === 0) {
      merged.push(...chunk)
      continue
    }

    const previousEndMs = merged[merged.length - 1].endMs
    let candidates = chunk.filter(
      (segment) => segment.endMs > previousEndMs + TEMPORAL_DUPLICATE_MS,
    )

    const first = candidates[0]
    if (first !== undefined && first.startMs < previousEndMs + SIMILARITY_WINDOW_MS) {
      const kMax = Math.min(MAX_OVERLAP_SEGMENTS, candidates.length, merged.length)
      let duplicates = 0
      for (let k = kMax; k >= 1; k--) {
        const tail = normalize(
          merged
            .slice(merged.length - k)
            .map((segment) => segment.text)
            .join(" "),
        )
        const head = normalize(
          candidates
            .slice(0, k)
            .map((segment) => segment.text)
            .join(" "),
        )
        if (jaccard(tail, head) >= SIMILARITY_THRESHOLD) {
          duplicates = k
          break
        }
      }
      candidates = candidates.slice(duplicates)
    }

    merged.push(...candidates)
  }

  return merged
    .sort((a, b) => a.startMs - b.startMs)
    .filter((segment) => normalize(segment.text) !== "")
}
