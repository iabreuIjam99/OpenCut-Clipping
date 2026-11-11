/**
 * Página de laboratorio temporal, dev-only, fuera del MVP.
 *
 * Permite validar manualmente (antes de Task 16) el pipeline de clipping:
 * elegir vídeo → validar con el guard de media → extraer audio con ffmpeg.wasm
 * → transcribir con Whisper local. Se elimina o sustituye por la UI real en
 * Tasks 18–19. En producción no renderiza UI ni carga módulos pesados.
 */

import { createFileRoute } from "@tanstack/react-router"
import { type ChangeEvent, useEffect, useRef, useState } from "react"
import { ClientOnly } from "../components/client-only"
import type { MediaInfo } from "../lib/clipping/media-guard"
import type { TranscriptSegment } from "../lib/media/transcript"

type ExtractedAudio = {
  readonly blob: Blob
  readonly url: string
  readonly durationMs: number
  readonly bytes: number
}

type StepProgress = {
  readonly step: "extract" | "transcribe"
  readonly value: number
}

export const Route = createFileRoute("/lab")({
  component: LabRoute,
  head: () => ({ meta: [{ name: "robots", content: "noindex" }] }),
})

function LabRoute() {
  if (!import.meta.env.DEV) return null
  return (
    <ClientOnly>
      <LabPage />
    </ClientOnly>
  )
}

function LabPage() {
  const [file, setFile] = useState<File | null>(null)
  const [info, setInfo] = useState<MediaInfo | null>(null)
  const [extracted, setExtracted] = useState<ExtractedAudio | null>(null)
  const [segments, setSegments] = useState<TranscriptSegment[] | null>(null)
  const [progress, setProgress] = useState<StepProgress | null>(null)
  const [status, setStatus] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<"extract" | "transcribe" | null>(null)

  const abortController = useRef<AbortController | null>(null)
  const operationInFlight = useRef(false)
  const pendingValidation = useRef(0)

  // Revoca la URL del objeto blob al desmontar o al sustituir la extracción.
  useEffect(() => {
    return () => {
      if (extracted?.url) URL.revokeObjectURL(extracted.url)
    }
  }, [extracted?.url])

  function formatMs(ms: number): string {
    const total = Math.max(0, Math.round(ms))
    const minutes = Math.floor(total / 60_000)
    const seconds = Math.floor((total % 60_000) / 1_000)
    const millis = total % 1_000
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`
  }

  function formatBytes(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
  }

  function cancelOperation(): void {
    abortController.current?.abort()
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const selected = event.target.files?.[0] ?? null
    abortController.current?.abort()
    if (extracted?.url) URL.revokeObjectURL(extracted.url)
    setFile(selected)
    setInfo(null)
    setExtracted(null)
    setSegments(null)
    setProgress(null)
    setBusy(null)
    setError(null)
    setStatus("")
    if (!selected) return
    if (!import.meta.env.DEV) return
    const myId = ++pendingValidation.current
    let mediaGuard: typeof import("../lib/clipping/media-guard") | undefined = undefined
    try {
      mediaGuard = await import("../lib/clipping/media-guard")
      const validated = await mediaGuard.validateMediaFile(selected)
      if (myId !== pendingValidation.current) return
      setInfo(validated)
      setStatus("Archivo validado.")
    } catch (err) {
      if (myId !== pendingValidation.current) return
      setStatus("")
      if (mediaGuard && err instanceof mediaGuard.MediaValidationError) {
        setError(`${err.message} (código: ${err.code})`)
      } else {
        setError("No se pudo validar el archivo.")
      }
    }
  }

  async function handleExtract(): Promise<void> {
    if (!import.meta.env.DEV) return
    if (!file || !info || operationInFlight.current || busy !== null || !info.hasAudio) return
    operationInFlight.current = true
    const controller = new AbortController()
    abortController.current = controller
    setBusy("extract")
    setError(null)
    setStatus("Extrayendo audio...")
    try {
      const extractAudioModule = await import("../lib/media/extract-audio")
      const result = await extractAudioModule.extractAudio(file, {
        onProgress: (p) => setProgress({ step: "extract", value: p }),
        signal: controller.signal,
      })
      const url = URL.createObjectURL(result.blob)
      setExtracted({
        blob: result.blob,
        url,
        durationMs: result.durationMs,
        bytes: result.blob.size,
      })
      setStatus("Audio extraído.")
    } catch (_err) {
      if (controller.signal.aborted) {
        setStatus("Extracción cancelada.")
      } else {
        setError("No se pudo extraer el audio.")
      }
    } finally {
      if (abortController.current === controller) abortController.current = null
      setBusy(null)
      setProgress(null)
      operationInFlight.current = false
    }
  }

  async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
    const context = new OfflineAudioContext(1, 1, 16_000)
    let decoded: AudioBuffer
    try {
      decoded = await context.decodeAudioData(await blob.arrayBuffer())
    } catch {
      throw new Error("No se pudo decodificar el audio extraído.")
    }
    const channels = decoded.numberOfChannels
    if (channels === 1) return decoded.getChannelData(0)
    const length = decoded.length
    const mono = new Float32Array(length)
    for (let channel = 0; channel < channels; channel += 1) {
      const data = decoded.getChannelData(channel)
      for (let index = 0; index < length; index += 1) {
        mono[index] += data[index] / channels
      }
    }
    return mono
  }

  async function handleTranscribe(): Promise<void> {
    if (!import.meta.env.DEV) return
    if (!extracted || operationInFlight.current || busy !== null) return
    operationInFlight.current = true
    const controller = new AbortController()
    abortController.current = controller
    setBusy("transcribe")
    setError(null)
    setStatus("Decodificando audio...")
    try {
      const transcribeModule = await import("../lib/media/transcribe-local")
      const audio = await decodeToMono16k(extracted.blob)
      const result = await transcribeModule.transcribeLocal(audio, {
        durationMs: extracted.durationMs,
        onProgress: (p) => setProgress({ step: "transcribe", value: p }),
        signal: controller.signal,
      })
      setSegments(result)
      setStatus(
        `Transcripción completa (${result.length} segmento${result.length === 1 ? "" : "s"}).`,
      )
    } catch (_err) {
      if (controller.signal.aborted) {
        setStatus("Transcripción cancelada.")
      } else {
        setError("No se pudo transcribir el audio.")
      }
    } finally {
      if (abortController.current === controller) abortController.current = null
      setBusy(null)
      setProgress(null)
      operationInFlight.current = false
    }
  }

  const totalCoveredMs =
    segments?.reduce((acc, segment) => acc + (segment.endMs - segment.startMs), 0) ?? 0

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <h1 className="text-lg font-semibold">Laboratorio de clipping</h1>
      <p className="text-sm text-gray-600">
        Página temporal solo para desarrollo. Valida el pipeline de clipping antes de Task 16; no
        forma parte del MVP.
      </p>

      {error && (
        <div
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          aria-live="polite"
        >
          {error}
        </div>
      )}
      {status && (
        <p className="text-sm text-gray-600" aria-live="polite">
          {status}
        </p>
      )}

      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-semibold">Diagnóstico</h2>
        <p className="text-sm text-gray-700 space-y-1">
          <span>
            WebGPU:{" "}
            {typeof navigator.gpu !== "undefined"
              ? "WebGPU disponible"
              : "Sin WebGPU: se usará WASM"}
          </span>
          <br />
          <span>Entorno aislado: {window.crossOriginIsolated ? "sí" : "no"}</span>
          <br />
          <span>
            Modelos: servidos desde <code>/models/</code> (local, sin red)
          </span>
        </p>
      </section>

      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-semibold">1. Elegir vídeo y validar</h2>
        <label htmlFor="lab-file-input" className="block text-sm">
          Archivo de vídeo
        </label>
        <input
          id="lab-file-input"
          type="file"
          accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/*"
          disabled={busy !== null}
          onChange={handleFileChange}
        />
        {info && file && (
          <div className="text-sm space-y-1">
            <p>Contenedor: {info.container}</p>
            <p>Duración: {formatMs(info.durationMs)}</p>
            <p>Pista de audio: {info.hasAudio ? "sí" : "no"}</p>
            <p>Tamaño: {formatBytes(file.size)}</p>
          </div>
        )}
      </section>

      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-semibold">2. Extraer audio</h2>
        <button
          disabled={!info?.hasAudio || busy !== null}
          onClick={handleExtract}
          className="px-3 py-1.5 text-sm rounded border"
        >
          Extraer audio
        </button>
        {progress?.step === "extract" && (
          <div className="text-sm space-y-1">
            <progress value={progress.value} max={1} className="w-24" />
            <span>{Math.round(progress.value * 100)}%</span>
          </div>
        )}
        {extracted && (
          <div className="text-sm space-y-1">
            <audio controls src={extracted.url} className="mt-1" />
            <a
              href={extracted.url}
              download="audio.webm"
              className="text-sm underline underline-offset-4"
            >
              Descargar audio.webm ({formatBytes(extracted.bytes)})
            </a>
          </div>
        )}
      </section>

      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-semibold">3. Transcribir</h2>
        <button
          disabled={!extracted || busy !== null}
          onClick={handleTranscribe}
          className="px-3 py-1.5 text-sm rounded border"
        >
          Transcribir
        </button>
        {progress?.step === "transcribe" && (
          <div className="text-sm space-y-1">
            <progress value={progress.value} max={1} className="w-24" />
            <span>{Math.round(progress.value * 100)}%</span>
          </div>
        )}
        {segments && (
          <div className="text-sm space-y-1">
            <p>Segmentos: {segments.length}</p>
            <p>Duración cubierta: {formatMs(totalCoveredMs)}</p>
            <ul className="list-disc pl-4 space-y-1">
              {segments.map((segment, index) => (
                <li key={index}>
                  {index + 1}. {formatMs(segment.startMs)} – {formatMs(segment.endMs)} —{" "}
                  {segment.text}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {busy !== null && (
        <button
          onClick={cancelOperation}
          className="px-3 py-1.5 text-sm rounded border border-red-300 text-red-700 bg-red-50"
        >
          Cancelar ({busy === "extract" ? "extracción" : "transcripción"})
        </button>
      )}
    </main>
  )
}
