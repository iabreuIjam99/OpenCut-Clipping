/**
 * Local Whisper transcription orchestration (Task 12, R1/R6).
 *
 * Pure orchestration: this module NEVER imports the transformers.js package
 * (only `transcribe.worker.ts` does), so it can be imported from SSR without
 * touching the `Worker` global — the Worker is created lazily inside
 * {@link transcribeLocal} through the injectable `workerFactory` (R1).
 *
 * Contract:
 * - `audio.buffer` is TRANSFERRED to the Worker (zero-copy): the caller loses
 *   the buffer and must not reuse `audio` afterwards. A `SharedArrayBuffer`
 *   view cannot be transferred and is posted without a transfer list.
 * - Abort: `terminate()` runs exactly once on every path (success, Worker
 *   error, abort) and the `abort` listener is always removed; an
 *   already-aborted signal rejects with {@link TranscriptionAbortedError}
 *   without creating the Worker (R6).
 * - Progress messages are clamped to `[0, 1]`, only advancing values are
 *   emitted, and success emits `1` as the last value.
 * - Failures surface as generic Spanish errors; the technical detail only
 *   reaches `console.error` under `import.meta.env.DEV` (same pattern as
 *   Tasks 9–11).
 *
 * Documented debt (Task 12): there is NO production importer of
 * `transcribeLocal` yet, so Vite tree-shakes this module and the Worker entry
 * (`transcribe.worker.ts`) is NOT emitted into `dist/client`. The chunk is
 * emitted only once a production module imports `transcribeLocal`; the Task 12
 * build proof was a temporary lib build (worker bundle ~72.8 MB) and the
 * permanent proof arrives with the UI task that wires the transcription
 * screen. Do NOT add an artificial import just to force emission.
 *
 * @module transcribe-local
 */

import {
  isTranscribeResponse,
  type TranscribeModel,
  type TranscribeRequest,
  type TranscribeWorkerLike,
} from "./transcribe-protocol"
import type { TranscriptSegment } from "./transcript"

export type TranscribeOptions = {
  /** Modelo a usar; `"base"` por defecto (los pesos los descarga `models:fetch`). */
  model?: TranscribeModel
  /** Código del idioma del audio; `"es"` por defecto. */
  language?: string
  /** Duración total del audio en ms: cierra el último timestamp. Obligatorio. */
  durationMs: number
  onProgress?: (p: number) => void
  signal?: AbortSignal
  /** Solo tests: fábrica inyectable del Worker (R1). */
  workerFactory?: () => TranscribeWorkerLike
}

/** Generic, Spanish, detail-free error surfaced to the caller (R6). */
export class TranscriptionError extends Error {
  readonly code: "TRANSCRIPTION_FAILED"

  constructor() {
    super("No se pudo transcribir el audio.")
    this.name = "TranscriptionError"
    this.code = "TRANSCRIPTION_FAILED"
  }
}

export class TranscriptionAbortedError extends Error {
  readonly code: "ABORTED"

  constructor() {
    super("La transcripción fue cancelada.")
    this.name = "TranscriptionAbortedError"
    this.code = "ABORTED"
  }
}

/** Audio vacío o duración inválida, detectado ANTES de crear el Worker (R6). */
export class TranscriptionNoAudioError extends Error {
  readonly code: "NO_AUDIO"

  constructor() {
    super("No hay audio para transcribir.")
    this.name = "TranscriptionNoAudioError"
    this.code = "NO_AUDIO"
  }
}

/**
 * Lazily builds the production Worker. The `new URL(...)` form is what Vite
 * statically analysés to emit the Worker as its own build entry; keeping it
 * inside a function (never at module scope) is what makes the orchestrator
 * importable from SSR (R1).
 */
function defaultWorkerFactory(): TranscribeWorkerLike {
  return new Worker(new URL("./transcribe.worker.ts", import.meta.url), { type: "module" })
}

function clampProgress(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** Reads `signal.aborted` through a call so TS never narrows it across awaits. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * Transcribes 16 kHz mono audio locally in a Worker (Whisper via
 * transformers.js, assets 100 % local — R2).
 *
 * The caller's `audio.buffer` is transferred to the Worker (zero-copy): after
 * this call the buffer is detached and `audio` must not be reused.
 *
 * @throws {TranscriptionAbortedError} `code: "ABORTED"` — the signal was
 *   already aborted, or it aborted while the Worker was running.
 * @throws {TranscriptionNoAudioError} `code: "NO_AUDIO"` — `audio.length === 0`
 *   or `durationMs <= 0`, detected before the Worker is created.
 * @throws {TranscriptionError} `code: "TRANSCRIPTION_FAILED"` — everything
 *   else, with a generic Spanish message and no technical detail.
 */
export async function transcribeLocal(
  audio: Float32Array,
  opts: TranscribeOptions,
): Promise<TranscriptSegment[]> {
  const signal = opts.signal
  const onProgress = opts.onProgress

  if (isAborted(signal)) throw new TranscriptionAbortedError()
  if (audio.length === 0 || !Number.isFinite(opts.durationMs) || opts.durationMs <= 0) {
    throw new TranscriptionNoAudioError()
  }

  const request: TranscribeRequest = {
    type: "transcribe",
    audio,
    durationMs: opts.durationMs,
    model: opts.model ?? "base",
    language: opts.language ?? "es",
  }

  const worker = (opts.workerFactory ?? defaultWorkerFactory)()
  let terminated = false
  let settled = false
  let lastProgress = -1

  const terminateOnce = (): void => {
    if (terminated) return
    terminated = true
    try {
      worker.terminate()
    } catch {
      /* el worker ya no existe */
    }
  }

  return await new Promise<TranscriptSegment[]>((resolve, reject) => {
    // `cleanup` closes over the handlers declared below; it only runs from
    // them (events), never during this synchronous block.
    const cleanup = (): void => {
      worker.removeEventListener("message", handleMessage)
      worker.removeEventListener("error", handleWorkerError)
      signal?.removeEventListener("abort", handleAbort)
      terminateOnce()
    }

    const emitProgress = (raw: number): void => {
      const value = clampProgress(raw)
      if (value <= lastProgress) return
      lastProgress = value
      try {
        onProgress?.(value)
      } catch (cause) {
        // A broken consumer callback must never strand the operation:
        // `lastProgress` already advanced (monotonic bookkeeping kept) and
        // progress is advisory — the promise settles through its own path.
        if (import.meta.env.DEV) {
          // biome-ignore lint/suspicious/noConsole: dev-only diagnostic, never exposed to the user
          console.error("[transcribe-local] onProgress lanzó una excepción", cause)
        }
      }
    }

    const succeed = (segments: TranscriptSegment[]): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(segments)
      // After `resolve` a throwing `onProgress` can no longer strand the
      // promise: the awaiter is already scheduled.
      emitProgress(1)
    }

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const handleMessage = (event: MessageEvent<unknown>): void => {
      if (settled) return
      const data: unknown = event.data
      if (!isTranscribeResponse(data)) {
        if (import.meta.env.DEV) {
          // biome-ignore lint/suspicious/noConsole: dev-only diagnostic, never exposed to the user
          console.error("[transcribe-local] mensaje no reconocido del Worker", data)
        }
        fail(new TranscriptionError())
        return
      }
      if (data.type === "progress") {
        emitProgress(data.progress)
        return
      }
      if (data.type === "result") {
        succeed(data.segments)
        return
      }
      if (data.code === "NO_AUDIO") {
        fail(new TranscriptionNoAudioError())
        return
      }
      if (import.meta.env.DEV) {
        // biome-ignore lint/suspicious/noConsole: dev-only diagnostic, never exposed to the user
        console.error("[transcribe-local] el Worker devolvió TRANSCRIPTION_FAILED")
      }
      fail(new TranscriptionError())
    }

    const handleAbort = (): void => {
      fail(new TranscriptionAbortedError())
    }

    // A Worker `error` (network, CSP or a module-evaluation crash before
    // `handleRequest`) never produces a `message`: without this listener the
    // promise would hang forever.
    const handleWorkerError = (event: ErrorEvent): void => {
      if (settled) return
      if (import.meta.env.DEV) {
        // biome-ignore lint/suspicious/noConsole: dev-only diagnostic, never exposed to the user
        console.error("[transcribe-local] el Worker falló", event.message)
      }
      fail(new TranscriptionError())
    }

    worker.addEventListener("message", handleMessage)
    worker.addEventListener("error", handleWorkerError)
    signal?.addEventListener("abort", handleAbort, { once: true })

    // The signal may have aborted while the Worker was being created.
    if (isAborted(signal)) {
      handleAbort()
      return
    }

    emitProgress(0)

    // Zero-copy: the caller loses `audio.buffer` (documented above).
    const buffer: ArrayBufferLike = audio.buffer
    const transfer: Transferable[] = buffer instanceof ArrayBuffer ? [buffer] : []
    try {
      worker.postMessage(request, transfer)
    } catch (error) {
      if (import.meta.env.DEV) {
        // biome-ignore lint/suspicious/noConsole: dev-only diagnostic, never exposed to the user
        console.error("[transcribe-local] no se pudo enviar la petición al Worker", error)
      }
      fail(new TranscriptionError())
    }
  })
}
