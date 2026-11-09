/**
 * Typed Worker protocol for local Whisper transcription (Task 12, R4).
 *
 * This module is the boundary between the orchestrator
 * (`transcribe-local.ts`) and the Worker (`transcribe.worker.ts`): BOTH import
 * it, but only the Worker imports `@huggingface/transformers` (R1).
 *
 * Contract:
 * - Everything that interprets data coming OUT of the Worker is pure and
 *   defensive here: the Worker is untrusted input, exactly like an external
 *   `postMessage` (R4).
 * - {@link toSegments} maps the real `pipeline()` output to absolute
 *   milliseconds and NEVER throws (R5): an unrecognizable shape yields `[]`.
 * - {@link isTranscribeResponse} validates the Worker → orchestrator
 *   direction; {@link isTranscribeRequest} validates the orchestrator → Worker
 *   direction (defense in depth inside the Worker).
 *
 * @module transcribe-protocol
 */

import type { TranscriptSegment } from "./transcript"

// Solo `base` está soportado en el MVP: `small` queda diferido hasta que
// exista `models:fetch --model small` (R3) — sin pesos no se anuncia soporte.
export type TranscribeModel = "base"

export type TranscribeDevice = "webgpu" | "wasm"

export type TranscribeRequest = {
  type: "transcribe"
  audio: Float32Array
  durationMs: number
  model: TranscribeModel
  language: string
}

export type TranscribeResponse =
  | { type: "progress"; progress: number }
  | { type: "result"; segments: TranscriptSegment[]; device: TranscribeDevice }
  | { type: "error"; code: "TRANSCRIPTION_FAILED" | "NO_AUDIO" }

/**
 * Structural shape of the `Worker` as seen by the orchestrator. A real
 * `Worker` satisfies it structurally; tests inject a fake with the same
 * surface (`workerFactory`, R1).
 */
export type TranscribeWorkerLike = {
  postMessage(message: TranscribeRequest, transfer?: Transferable[]): void
  terminate(): void
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void
  removeEventListener(type: "error", listener: (event: ErrorEvent) => void): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Maps the real output of the ASR pipeline (`{ text, chunks }`) to absolute
 * milliseconds over the whole audio (R5). Pure and defensive:
 *
 * - `startMs = Math.round(startS * 1000)` clamped to `[0, durationMs]`.
 * - `endMs = endS === null ? durationMs : Math.round(endS * 1000)`, then
 *   `min(max(endMs, startMs), durationMs)` (a missing/NaN end behaves like
 *   `null`: it runs to the end of the audio).
 * - Segments with blank `text` are dropped; an unrecognizable `chunk` is
 *   skipped without poisoning its siblings.
 * - The result is stably sorted by `startMs` before returning (native
 *   `Array#sort` is stable): Whisper normally emits ordered chunks, but the
 *   boundary is untrusted, so ordering is enforced here. Clamping, the
 *   null-end rule and the text-only fallback are unaffected.
 * - No `chunks` but a non-blank `text` → a single `[0, durationMs]` segment.
 * - Unrecognizable output (or an unusable `durationMs`) → `[]`; this function
 *   never throws — real inference errors arrive via the `error` message.
 *
 * Deliberately does NOT reuse Task 11's `mergeTranscripts`: there is a single
 * pass here and no overlap to deduplicate (R5).
 */
export function toSegments(output: unknown, durationMs: number): TranscriptSegment[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return []
  if (!isRecord(output)) return []

  const { text, chunks } = output
  if (Array.isArray(chunks) && chunks.length > 0) {
    const segments: TranscriptSegment[] = []
    for (const chunk of chunks) {
      if (!isRecord(chunk)) continue
      const { timestamp, text: chunkText } = chunk
      if (typeof chunkText !== "string" || chunkText.trim() === "") continue
      if (!Array.isArray(timestamp)) continue

      const startS = timestamp[0]
      if (typeof startS !== "number" || !Number.isFinite(startS)) continue
      const startMs = clamp(Math.round(startS * 1000), 0, durationMs)

      const endS = timestamp[1]
      const rawEndMs =
        typeof endS === "number" && Number.isFinite(endS) ? Math.round(endS * 1000) : durationMs
      const endMs = clamp(Math.max(rawEndMs, startMs), 0, durationMs)

      segments.push({ startMs, endMs, text: chunkText })
    }
    // Whisper normally emits ordered chunks, but the boundary is untrusted:
    // stably sort by `startMs` before returning (native `Array#sort` is
    // stable, so equal starts keep their arrival order).
    segments.sort((a, b) => a.startMs - b.startMs)
    return segments
  }

  if (typeof text === "string" && text.trim() !== "") {
    return [{ startMs: 0, endMs: durationMs, text }]
  }
  return []
}

function isTranscriptSegment(value: unknown): value is TranscriptSegment {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    typeof value.startMs === "number" &&
    Number.isFinite(value.startMs) &&
    typeof value.endMs === "number" &&
    Number.isFinite(value.endMs)
  )
}

/**
 * Validates the Worker → orchestrator boundary (R4). Anything else (garbage,
 * `null`, half-built objects, arrays) must be rejected so the orchestrator can
 * fail fast instead of hanging.
 */
export function isTranscribeResponse(value: unknown): value is TranscribeResponse {
  if (!isRecord(value)) return false
  if (value.type === "progress") {
    return typeof value.progress === "number" && Number.isFinite(value.progress)
  }
  if (value.type === "result") {
    return (
      (value.device === "webgpu" || value.device === "wasm") &&
      Array.isArray(value.segments) &&
      value.segments.every(isTranscriptSegment)
    )
  }
  if (value.type === "error") {
    return value.code === "TRANSCRIPTION_FAILED" || value.code === "NO_AUDIO"
  }
  return false
}

/**
 * Validates the orchestrator → Worker direction. The Worker re-checks the
 * request before touching the model so a malformed message can never reach
 * `pipeline()` (defense in depth; R6).
 */
export function isTranscribeRequest(value: unknown): value is TranscribeRequest {
  if (!isRecord(value)) return false
  if (value.type !== "transcribe") return false
  if (!(value.audio instanceof Float32Array)) return false
  if (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs)) return false
  if (value.model !== "base") return false
  return typeof value.language === "string"
}
