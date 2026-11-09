/**
 * Local Whisper transcription Worker (Task 12, R1/R2).
 *
 * The ONLY module that imports `@huggingface/transformers`; the orchestrator
 * (`transcribe-local.ts`) talks to it through the typed protocol in
 * `./transcribe-protocol`.
 *
 * Contract:
 * - Before any `pipeline()` call the environment is pinned to LOCAL assets:
 *   no huggingface.co, no jsDelivr (R2). The model lives under `/models/`
 *   (fetched once by `bun run models:fetch`) and the ONNX Runtime binaries
 *   under `/ort/` (copied by the Vite plugin).
 * - WebGPU first with the spike's dtype recipe (encoder fp32 + decoder q4);
 *   if `navigator.gpu` is absent or the pipeline/inference fails, it retries
 *   once on WASM with dtype q8, and the device actually used travels in the
 *   `result` message (R6).
 * - The request is re-validated at the boundary and every failure surfaces
 *   as the generic `TRANSCRIPTION_FAILED` code; the technical detail only
 *   reaches `console.error` in development.
 *
 * @module transcribe.worker
 */

import type { DataType, ProgressInfo } from "@huggingface/transformers"
import { env, pipeline } from "@huggingface/transformers"
import {
  isTranscribeRequest,
  type TranscribeDevice,
  type TranscribeRequest,
  type TranscribeResponse,
  toSegments,
} from "./transcribe-protocol"
import type { TranscriptSegment } from "./transcript"

// ---------------------------------------------------------------------------
// R2: entorno 100 % local — ANTES de crear ningún pipeline.
// `import` ejecuta primero los side-effects de transformers.js (que llega a
// apuntar wasmPaths a jsDelivr), así que este cuerpo los sobreescribe.
// ---------------------------------------------------------------------------

env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = "/models/"

// `env.backends.onnx.wasm` es el MISMO objeto de banderas que lee ORT
// (transformers.js lo copia por referencia desde `ort.env`): se muta IN SITIO.
// Sustituir el objeto dejaría a ORT leyendo el original con el default de CDN.
const ortWasm = env.backends.onnx.wasm
if (ortWasm === undefined) {
  if (import.meta.env.DEV) {
    // biome-ignore lint/suspicious/noConsole: dev-only diagnostic, never reaches the user
    console.error("[transcribe.worker] env.backends.onnx.wasm ausente: rutas locales no fijadas")
  }
} else {
  ortWasm.wasmPaths = {
    mjs: "/ort/ort-wasm-simd-threaded.asyncify.mjs",
    wasm: "/ort/ort-wasm-simd-threaded.asyncify.wasm",
  }
}

// ---------------------------------------------------------------------------
// Constantes (spike de Task 7: receta GO verificada)
// ---------------------------------------------------------------------------

// MVP: `models:fetch` solo soporta `whisper-base` (9 ficheros, R3); `small`
// se añadirá cuando exista su propio fetch. Nunca se pide red (R2).
const MODEL_ID = "onnx-community/whisper-base"

/** Receta WebGPU: encoder fp32 + decoder q4 (los 9 ficheros pineados, R3). */
const WEBGPU_DTYPE: Record<string, DataType> = {
  model: "fp32",
  encoder_model: "fp32",
  decoder_model_merged: "q4",
  decoder_model: "q4",
}

/** Fallback CPU: q8 (spike §10; requiere los ficheros `_quantized`). */
const WASM_DTYPE: Record<string, DataType> = {
  model: "q8",
  encoder_model: "q8",
  decoder_model_merged: "q8",
  decoder_model: "q8",
}

// ---------------------------------------------------------------------------
// Mensajes (R4)
// ---------------------------------------------------------------------------

/** Single-argument `postMessage`: sin transferencias de vuelta al main. */
function post(response: TranscribeResponse): void {
  self.postMessage(response)
}

/** `progress`/`progress_total` llegan en 0–100; el resto de estados no miden nada. */
function handleProgress(info: ProgressInfo): void {
  if (info.status !== "progress" && info.status !== "progress_total") return
  const fraction = info.progress / 100
  post({ type: "progress", progress: Math.min(Math.max(fraction, 0), 1) })
}

// ---------------------------------------------------------------------------
// Pipeline + fallback (R6)
// ---------------------------------------------------------------------------

async function runAttempt(
  request: TranscribeRequest,
  device: TranscribeDevice,
): Promise<TranscriptSegment[]> {
  const transcriber = await pipeline("automatic-speech-recognition", MODEL_ID, {
    device,
    dtype: device === "webgpu" ? WEBGPU_DTYPE : WASM_DTYPE,
    progress_callback: handleProgress,
  })
  // La salida de `pipeline` es opaca: viaja como `unknown` y la valida
  // `toSegments` (R5) — sin casts (R9).
  const output: unknown = await transcriber(request.audio, {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    language: request.language,
    task: "transcribe",
  })
  return toSegments(output, request.durationMs)
}

async function run(
  request: TranscribeRequest,
): Promise<{ device: TranscribeDevice; segments: TranscriptSegment[] }> {
  // `navigator.gpu` puede faltar por completo o ser `undefined` (p. ej. la
  // receta R8 del smoke de navegador): en ambos casos no hay WebGPU real y se
  // va DIRECTO a WASM — intentar WebGPU con el getter anulado solo provoca
  // el error "WebGPU is not supported" de ORT antes de reintentar.
  if (navigator.gpu) {
    try {
      return { device: "webgpu", segments: await runAttempt(request, "webgpu") }
    } catch (error) {
      if (import.meta.env.DEV) {
        // biome-ignore lint/suspicious/noConsole: dev-only diagnostic, never reaches the user
        console.error("[transcribe.worker] WebGPU falló; se reintenta en WASM", error)
      }
    }
  }
  return { device: "wasm", segments: await runAttempt(request, "wasm") }
}

async function handleRequest(data: unknown): Promise<void> {
  try {
    if (!isTranscribeRequest(data)) {
      post({ type: "error", code: "TRANSCRIPTION_FAILED" })
      return
    }
    if (data.audio.length === 0 || data.durationMs <= 0) {
      post({ type: "error", code: "NO_AUDIO" })
      return
    }
    const { device, segments } = await run(data)
    post({ type: "result", segments, device })
  } catch (error) {
    if (import.meta.env.DEV) {
      // biome-ignore lint/suspicious/noConsole: dev-only diagnostic, never reaches the user
      console.error("[transcribe.worker] transcripción fallida", error)
    }
    post({ type: "error", code: "TRANSCRIPTION_FAILED" })
  }
}

// `handleRequest` trapa todo su cuerpo; esta red es solo por si `post` falla.
self.addEventListener("message", (event: MessageEvent<unknown>): void => {
  void handleRequest(event.data)
})
