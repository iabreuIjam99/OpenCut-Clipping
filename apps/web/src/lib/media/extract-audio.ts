/**
 * Audio extraction orchestration (ffmpeg.wasm + WORKERFS, ADR-02).
 *
 * Pure and testable: the ffmpeg.wasm runtime is injectable (`opts.runtime`),
 * because jsdom cannot execute the WASM core. In production the runtime comes
 * from {@link createFfmpegRuntime}, whose module is the only one that loads
 * `@ffmpeg/ffmpeg` (dynamically).
 *
 * Contract:
 * - `durationMs` comes from `validateMediaFile` (Task 9 guard), called exactly
 *   once and before any runtime work; its `MediaValidationError` propagates
 *   unchanged.
 * - The video is mounted with WORKERFS under the fixed name `input.bin`; its
 *   bytes are never copied into the WASM heap (OOM trap avoided in the Task 6
 *   spike).
 * - `terminate()` always runs; after an abort there is no unmount/delete
 *   (the worker and its MEMFS no longer exist).
 *
 * @module extract-audio
 */

import { validateMediaFile } from "../clipping/media-guard"
import { type AudioExtractionRuntime, createFfmpegRuntime } from "./ffmpeg-runtime"

export type ExtractAudioOptions = {
  onProgress?: (p: number) => void
  signal?: AbortSignal
  /** Solo tests: runtime inyectado; en producción se crea el de ffmpeg.wasm. */
  runtime?: AudioExtractionRuntime
}

/** Generic, Spanish, detail-free errors surfaced to the caller (R7). */
export class AudioExtractionError extends Error {
  readonly code: "EXTRACTION_FAILED"

  constructor() {
    super("No se pudo extraer el audio del vídeo.")
    this.name = "AudioExtractionError"
    this.code = "EXTRACTION_FAILED"
  }
}

export class AbortedError extends Error {
  readonly code: "ABORTED"

  constructor() {
    super("La extracción de audio fue cancelada.")
    this.name = "AbortedError"
    this.code = "ABORTED"
  }
}

/** Fixed paths and command (ADR-02, `-vbr off` mandatory). */
const FFMPEG_ARGS = [
  "-i",
  "/input/input.bin",
  "-vn",
  "-ac",
  "1",
  "-ar",
  "16000",
  "-c:a",
  "libopus",
  "-b:a",
  "24k",
  "-vbr",
  "off",
  "-f",
  "webm",
  "/output/audio.webm",
] as const

function clampProgress(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** Reads `signal.aborted` through a call so TS never narrows it across awaits. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

export async function extractAudio(
  file: File,
  opts?: ExtractAudioOptions,
): Promise<{ blob: Blob; durationMs: number; codec: "opus" | "mp3" }> {
  const signal = opts?.signal
  const onProgress = opts?.onProgress

  if (isAborted(signal)) throw new AbortedError()

  // Single guard call per extraction: duration + limits + audio-track checks.
  const { durationMs } = await validateMediaFile(file)

  // The signal may have aborted while the guard was reading the file.
  if (isAborted(signal)) throw new AbortedError()

  const runtime = opts?.runtime ?? createFfmpegRuntime()
  let aborted = false
  let terminated = false
  const handleAbort = (): void => {
    aborted = true
    terminated = true
    try {
      runtime.terminate()
    } catch {
      /* el worker ya no existe */
    }
  }
  signal?.addEventListener("abort", handleAbort, { once: true })

  try {
    runtime.onProgress((value) => onProgress?.(clampProgress(value)))
    onProgress?.(0)

    await runtime.load()
    await runtime.createDir("/input")
    await runtime.createDir("/output")

    // Renames without copying bytes; blocks path/name injection.
    const renamed = new File([file], "input.bin")
    const mounted = await runtime.mount(renamed, "/input")
    if (!mounted) throw new Error("WORKERFS no disponible en el montaje")

    const exitCode = await runtime.exec(FFMPEG_ARGS)
    if (exitCode !== 0) throw new Error(`ffmpeg devolvió exit code ${exitCode}`)

    const data = await runtime.readFile("/output/audio.webm")
    if (typeof data === "string") throw new Error("la salida no es un buffer binario")

    onProgress?.(1)
    // TS 6 requires ArrayBufferView<ArrayBuffer>; the Blob snapshots the bytes
    // by spec anyway, so the defensive copy is free of semantic change.
    return {
      blob: new Blob([new Uint8Array(data)], { type: "audio/webm" }),
      durationMs,
      codec: "opus",
    }
  } catch (error) {
    // An abort makes every in-flight promise reject: translate, never leak it.
    if (aborted) throw new AbortedError()
    if (import.meta.env.DEV) {
      // biome-ignore lint/suspicious/noConsole: dev-only diagnostic, never exposed to the user
      console.error("[extract-audio] extraccion fallida", error)
    }
    throw new AudioExtractionError()
  } finally {
    signal?.removeEventListener("abort", handleAbort)
    if (!aborted) {
      // R8 order; each step tolerates its own failure without masking the result.
      try {
        await runtime.deleteFile("/output/audio.webm")
      } catch {
        /* ya no existe */
      }
      try {
        await runtime.deleteDir("/output")
      } catch {
        /* ya no existe */
      }
      try {
        await runtime.unmount("/input")
      } catch {
        /* no estaba montado */
      }
      try {
        await runtime.deleteDir("/input")
      } catch {
        /* ya no existe */
      }
    }
    try {
      if (!terminated) runtime.terminate()
    } catch {
      /* el worker ya no existe */
    }
  }
}
