import { describe, expect, it, vi } from "vitest"
import fixture from "./__fixtures__/whisper-base-10s.json"
import {
  TranscriptionAbortedError,
  TranscriptionError,
  TranscriptionNoAudioError,
  transcribeLocal,
} from "./transcribe-local"
import {
  type TranscribeRequest,
  type TranscribeWorkerLike,
  toSegments,
} from "./transcribe-protocol"

/**
 * Orchestration tests run against an injected fake worker (R1): jsdom cannot
 * run a Worker scope nor the Whisper pipeline (R9), so only the protocol and
 * the orchestration are exercised here. The REAL WebGPU → WASM fallback lives
 * inside `transcribe.worker.ts` and is validated by the browser smoke (R8).
 *
 * The fake mirrors the `Worker` surface used by `transcribeLocal`
 * (`TranscribeWorkerLike`) and records every interaction, so the tests can
 * assert exact requests, transfer lists, listener cleanup and `terminate()`
 * counts.
 */

// ---------------------------------------------------------------------------
// Fake worker
// ---------------------------------------------------------------------------

type MessageListener = (event: MessageEvent<unknown>) => void
type ErrorListener = (event: ErrorEvent) => void

class FakeWorker implements TranscribeWorkerLike {
  readonly postCalls: Array<{ message: TranscribeRequest; transfer: Transferable[] }> = []
  readonly removed: Array<MessageListener | ErrorListener> = []
  terminateCalls = 0
  addCalls = 0
  postShouldThrow = false
  readonly #messageListeners = new Set<MessageListener>()
  readonly #errorListeners = new Set<ErrorListener>()

  postMessage(message: TranscribeRequest, transfer: Transferable[] = []): void {
    if (this.postShouldThrow) throw new Error("postMessage falló")
    this.postCalls.push({ message, transfer })
  }

  terminate(): void {
    this.terminateCalls++
  }

  addEventListener(type: "message", listener: MessageListener): void
  addEventListener(type: "error", listener: ErrorListener): void
  addEventListener(type: "message" | "error", listener: MessageListener | ErrorListener): void {
    this.addCalls++
    // El sobrecargado garantiza que `listener` corresponde a `type`.
    if (type === "error") this.#errorListeners.add(listener as ErrorListener)
    else this.#messageListeners.add(listener as MessageListener)
  }

  removeEventListener(type: "message", listener: MessageListener): void
  removeEventListener(type: "error", listener: ErrorListener): void
  removeEventListener(type: "message" | "error", listener: MessageListener | ErrorListener): void {
    this.removed.push(listener)
    if (type === "error") this.#errorListeners.delete(listener as ErrorListener)
    else this.#messageListeners.delete(listener as MessageListener)
  }

  /** Delivers a Worker → orchestrator message like the real event loop. */
  emit(data: unknown): void {
    const event: MessageEvent<unknown> = new MessageEvent("message", { data })
    for (const listener of [...this.#messageListeners]) listener(event)
  }

  /** Delivers an `error` event (network, CSP or module-evaluation failure). */
  emitError(message: string): void {
    const event = new ErrorEvent("error", { message })
    for (const listener of [...this.#errorListeners]) listener(event)
  }

  get listenerCount(): number {
    return this.#messageListeners.size + this.#errorListeners.size
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 10 s de audio 16 kHz mono (contenido irrelevante: nada se decodifica). */
const tenSeconds = (): Float32Array => new Float32Array(160_000)

const shortAudio = (): Float32Array => new Float32Array(16)

const webgpuSegments = () => toSegments(fixture, 10_000)

/** Silences the dev-only `console.error` diagnostics while asserting them. */
function silenceConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {})
}

// ---------------------------------------------------------------------------
// Scenarios (1:1 with features/transcripcion.feature)
// ---------------------------------------------------------------------------

describe("transcribeLocal", () => {
  it("Scenario: Transcribir un audio de 10 s devuelve segmentos con tiempos absolutos", async () => {
    const fake = new FakeWorker()
    const source = tenSeconds()

    const pending = transcribeLocal(source, {
      durationMs: 10_000,
      workerFactory: () => fake,
    })
    fake.emit({ type: "progress", progress: 60 })
    fake.emit({ type: "result", device: "webgpu", segments: webgpuSegments() })

    const segments = await pending
    expect(segments.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
      [0, 2840],
      [2840, 6420],
      [6420, 10_000],
    ])
    expect(segments[2]?.text).toBe(" transcripción local con Whisper.")
    expect(segments.map((segment) => segment.text).join("")).toContain("transcripción local")

    const request = fake.postCalls[0]?.message
    expect(fake.postCalls).toHaveLength(1)
    expect(request?.type).toBe("transcribe")
    expect(request?.model).toBe("base")
    expect(request?.language).toBe("es")
    expect(request?.durationMs).toBe(10_000)
    expect(request?.audio).toBe(source)
    expect(fake.terminateCalls).toBe(1)
  })

  it("Scenario: Sin WebGPU, el Worker cae a WASM y sigue devolviendo segmentos", async () => {
    const fake = new FakeWorker()
    const source = tenSeconds()
    const segments = [{ startMs: 0, endMs: 10_000, text: " hola" }]

    const pending = transcribeLocal(source, {
      durationMs: 10_000,
      workerFactory: () => fake,
    })
    // El Worker real reintenta con `dtype` q8 cuando WebGPU falla (R6) y el
    // `result` viaja con `device: "wasm"`; el orquestador solo propaga.
    fake.emit({ type: "result", device: "wasm", segments })

    await expect(pending).resolves.toEqual(segments)
    expect(fake.postCalls[0]?.transfer).toEqual([source.buffer])
    expect(fake.postCalls[0]?.transfer).toHaveLength(1)
  })

  it("Scenario: Cancelar con AbortSignal termina el Worker y rechaza con ABORTED", async () => {
    const fake = new FakeWorker()
    const controller = new AbortController()

    const pending = transcribeLocal(tenSeconds(), {
      durationMs: 10_000,
      signal: controller.signal,
      workerFactory: () => fake,
    })
    expect(fake.postCalls).toHaveLength(1) // la petición está en vuelo

    controller.abort()

    await expect(pending).rejects.toBeInstanceOf(TranscriptionAbortedError)
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" })
    expect(fake.terminateCalls).toBe(1)
    expect(fake.listenerCount).toBe(0)
    expect(fake.removed).toHaveLength(2) // listeners "message" + "error"
  })

  it("Scenario: Un error del modelo se convierte en TRANSCRIPTION_FAILED genérico (sin filtrar rutas ni mensajes de ORT)", async () => {
    const spy = silenceConsoleError()
    try {
      const fake = new FakeWorker()
      const pending = transcribeLocal(shortAudio(), {
        durationMs: 1000,
        workerFactory: () => fake,
      })
      fake.emit({ type: "error", code: "TRANSCRIPTION_FAILED" })

      await expect(pending).rejects.toBeInstanceOf(TranscriptionError)
      await expect(pending).rejects.toMatchObject({
        code: "TRANSCRIPTION_FAILED",
        message: "No se pudo transcribir el audio.",
      })
      await expect(pending).rejects.toHaveProperty(
        "message",
        expect.not.stringMatching(
          /onnx|huggingface|transformers|jsdelivr|pipeline|dtype|q4|q8|ORT|worker|\.onnx|models\//i,
        ),
      )
      expect(fake.terminateCalls).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  it("Scenario: El progreso es monótono de 0 a 1 y termina en 1", async () => {
    const fake = new FakeWorker()
    const values: number[] = []

    const pending = transcribeLocal(tenSeconds(), {
      durationMs: 10_000,
      onProgress: (value) => values.push(value),
      workerFactory: () => fake,
    })
    fake.emit({ type: "progress", progress: 0.4 })
    fake.emit({ type: "progress", progress: 0.2 })
    fake.emit({ type: "progress", progress: 0.9 })
    fake.emit({ type: "progress", progress: 1.5 })
    fake.emit({ type: "result", device: "webgpu", segments: [] })

    await pending
    expect(values).toEqual([0, 0.4, 0.9, 1])
    for (let index = 1; index < values.length; index++) {
      expect(values[index]).toBeGreaterThan(values[index - 1] as number)
    }
    expect(values.at(-1)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Additional tests (brief R7)
// ---------------------------------------------------------------------------

describe("transcribeLocal (detalles)", () => {
  it("sends the exact request with default and explicit options", async () => {
    const defaults = new FakeWorker()
    const defaultAudio = shortAudio()
    const pendingDefaults = transcribeLocal(defaultAudio, {
      durationMs: 2500,
      workerFactory: () => defaults,
    })
    expect(defaults.postCalls[0]?.message).toEqual({
      type: "transcribe",
      audio: defaultAudio,
      durationMs: 2500,
      model: "base",
      language: "es",
    })
    defaults.emit({ type: "result", device: "webgpu", segments: [] })
    await expect(pendingDefaults).resolves.toEqual([])

    const explicit = new FakeWorker()
    const pendingExplicit = transcribeLocal(shortAudio(), {
      durationMs: 9000,
      model: "base",
      language: "en",
      workerFactory: () => explicit,
    })
    expect(explicit.postCalls[0]?.message).toMatchObject({
      type: "transcribe",
      durationMs: 9000,
      model: "base",
      language: "en",
    })
    explicit.emit({ type: "result", device: "wasm", segments: [] })
    await expect(pendingExplicit).resolves.toEqual([])
  })

  it.skipIf(typeof SharedArrayBuffer === "undefined")(
    "posts a SharedArrayBuffer view without a transfer list",
    async () => {
      const fake = new FakeWorker()
      const shared = new Float32Array(new SharedArrayBuffer(64))

      const pending = transcribeLocal(shared, {
        durationMs: 1000,
        workerFactory: () => fake,
      })
      expect(fake.postCalls[0]?.transfer).toEqual([])
      fake.emit({ type: "result", device: "wasm", segments: [] })

      await expect(pending).resolves.toEqual([])
    },
  )

  it("rejects NO_AUDIO without creating the Worker when audio is empty", async () => {
    const factory = vi.fn(() => new FakeWorker())

    await expect(
      transcribeLocal(new Float32Array(0), { durationMs: 10_000, workerFactory: factory }),
    ).rejects.toBeInstanceOf(TranscriptionNoAudioError)
    expect(factory).not.toHaveBeenCalled()
  })

  it("rejects NO_AUDIO without creating the Worker when durationMs is invalid", async () => {
    const factory = vi.fn(() => new FakeWorker())

    for (const durationMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        transcribeLocal(shortAudio(), { durationMs, workerFactory: factory }),
      ).rejects.toMatchObject({ code: "NO_AUDIO" })
    }
    expect(factory).not.toHaveBeenCalled()
  })

  it("rejects with ABORTED without creating the Worker when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const factory = vi.fn(() => new FakeWorker())

    await expect(
      transcribeLocal(shortAudio(), {
        durationMs: 1000,
        signal: controller.signal,
        workerFactory: factory,
      }),
    ).rejects.toBeInstanceOf(TranscriptionAbortedError)
    expect(factory).not.toHaveBeenCalled()
  })

  it("rejects with ABORTED when the signal aborts while the Worker is being created", async () => {
    const fake = new FakeWorker()
    const controller = new AbortController()
    const factory = vi.fn(() => {
      controller.abort()
      return fake
    })

    const pending = transcribeLocal(shortAudio(), {
      durationMs: 1000,
      signal: controller.signal,
      workerFactory: factory,
    })

    expect(factory).toHaveBeenCalledTimes(1)
    expect(fake.postCalls).toHaveLength(0) // la petición nunca salió
    expect(fake.terminateCalls).toBe(1)
    expect(fake.listenerCount).toBe(0)
    await expect(pending).rejects.toBeInstanceOf(TranscriptionAbortedError)
  })

  it("maps a Worker NO_AUDIO message to TranscriptionNoAudioError", async () => {
    const fake = new FakeWorker()
    const pending = transcribeLocal(shortAudio(), {
      durationMs: 1000,
      workerFactory: () => fake,
    })
    fake.emit({ type: "error", code: "NO_AUDIO" })

    await expect(pending).rejects.toBeInstanceOf(TranscriptionNoAudioError)
    await expect(pending).rejects.toMatchObject({
      code: "NO_AUDIO",
      message: "No hay audio para transcribir.",
    })
    expect(fake.terminateCalls).toBe(1)
  })

  it("rejects with TRANSCRIPTION_FAILED when the Worker sends an unrecognizable message", async () => {
    const spy = silenceConsoleError()
    try {
      const invalidDevice = new FakeWorker()
      const pendingInvalid = transcribeLocal(shortAudio(), {
        durationMs: 1000,
        workerFactory: () => invalidDevice,
      })
      invalidDevice.emit({ type: "result", device: "cpu", segments: [] })

      await expect(pendingInvalid).rejects.toBeInstanceOf(TranscriptionError)
      expect(invalidDevice.terminateCalls).toBe(1)
      expect(invalidDevice.listenerCount).toBe(0)

      const garbage = new FakeWorker()
      const pendingGarbage = transcribeLocal(shortAudio(), {
        durationMs: 1000,
        workerFactory: () => garbage,
      })
      garbage.emit("basura")

      await expect(pendingGarbage).rejects.toBeInstanceOf(TranscriptionError)
      expect(garbage.terminateCalls).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  it("maps a postMessage failure to TRANSCRIPTION_FAILED", async () => {
    const spy = silenceConsoleError()
    try {
      const fake = new FakeWorker()
      fake.postShouldThrow = true

      const pending = transcribeLocal(shortAudio(), {
        durationMs: 1000,
        workerFactory: () => fake,
      })

      await expect(pending).rejects.toBeInstanceOf(TranscriptionError)
      await expect(pending).rejects.toMatchObject({ code: "TRANSCRIPTION_FAILED" })
      expect(fake.terminateCalls).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  it("terminates the Worker exactly once on success and on error", async () => {
    const succeeding = new FakeWorker()
    const success = transcribeLocal(shortAudio(), {
      durationMs: 1000,
      workerFactory: () => succeeding,
    })
    succeeding.emit({ type: "result", device: "webgpu", segments: [] })
    await success
    expect(succeeding.terminateCalls).toBe(1)
    expect(succeeding.removed).toHaveLength(2) // listeners "message" + "error"

    const spy = silenceConsoleError()
    try {
      const failing = new FakeWorker()
      const failure = transcribeLocal(shortAudio(), {
        durationMs: 1000,
        workerFactory: () => failing,
      })
      failing.emit({ type: "error", code: "TRANSCRIPTION_FAILED" })

      await expect(failure).rejects.toBeInstanceOf(TranscriptionError)
      expect(failing.terminateCalls).toBe(1)
      expect(failing.removed).toHaveLength(2) // listeners "message" + "error"
    } finally {
      spy.mockRestore()
    }
  })

  it("clamps progress to [0, 1] and only emits advancing values", async () => {
    const fake = new FakeWorker()
    const values: number[] = []

    const pending = transcribeLocal(shortAudio(), {
      durationMs: 1000,
      onProgress: (value) => values.push(value),
      workerFactory: () => fake,
    })
    fake.emit({ type: "progress", progress: -0.5 })
    fake.emit({ type: "progress", progress: 0.3 })
    fake.emit({ type: "progress", progress: 0.15 })
    fake.emit({ type: "progress", progress: 1.2 })
    fake.emit({ type: "result", device: "wasm", segments: [] })

    await pending
    expect(values).toEqual([0, 0.3, 1])
  })

  it("emits 1 as the last progress value when the Worker never reports it", async () => {
    const fake = new FakeWorker()
    const values: number[] = []

    const pending = transcribeLocal(shortAudio(), {
      durationMs: 1000,
      onProgress: (value) => values.push(value),
      workerFactory: () => fake,
    })
    fake.emit({ type: "progress", progress: 0.5 })
    fake.emit({ type: "result", device: "webgpu", segments: [] })

    await pending
    expect(values).toEqual([0, 0.5, 1])
  })

  it("keeps the resolved result when onProgress throws after settling", async () => {
    const spy = silenceConsoleError()
    try {
      const fake = new FakeWorker()
      const pending = transcribeLocal(shortAudio(), {
        durationMs: 1000,
        onProgress: (value) => {
          if (value === 1) throw new Error("onProgress falló")
        },
        workerFactory: () => fake,
      })
      const segments = [{ startMs: 0, endMs: 1000, text: " hola" }]

      // `succeed` resuelve ANTES de emitir el 1: el fallo del callback se
      // traga (sin excepción sin capturar que pueda colgar el runner) y la
      // promesa conserva su resultado.
      expect(() => fake.emit({ type: "result", device: "webgpu", segments })).not.toThrow()
      await expect(pending).resolves.toEqual(segments)
      expect(fake.terminateCalls).toBe(1)
      expect(spy).toHaveBeenCalledWith(
        "[transcribe-local] onProgress lanzó una excepción",
        expect.objectContaining({ message: "onProgress falló" }),
      )
    } finally {
      spy.mockRestore()
    }
  })

  it("keeps the promise alive when onProgress throws mid-stream", async () => {
    const spy = silenceConsoleError()
    try {
      const fake = new FakeWorker()
      const received: number[] = []
      const segments = [{ startMs: 0, endMs: 1000, text: " hola" }]
      const pending = transcribeLocal(shortAudio(), {
        durationMs: 1000,
        onProgress: (value) => {
          received.push(value)
          if (value === 0.4) throw new Error("onProgress falló")
        },
        workerFactory: () => fake,
      })

      // Un callback roto en el 0.4 no puede dejar la promesa PENDIENTE para
      // siempre: la excepción se traga y el flujo sigue hasta el `result`.
      fake.emit({ type: "progress", progress: 0.1 })
      fake.emit({ type: "progress", progress: 0.4 })
      fake.emit({ type: "result", device: "webgpu", segments })

      await expect(pending).resolves.toEqual(segments)
      expect(fake.terminateCalls).toBe(1)
      // El bookkeeping monótono se mantiene: el 1 final sí se emite.
      expect(received).toEqual([0, 0.1, 0.4, 1])
      expect(spy).toHaveBeenCalledWith(
        "[transcribe-local] onProgress lanzó una excepción",
        expect.objectContaining({ message: "onProgress falló" }),
      )
    } finally {
      spy.mockRestore()
    }
  })

  it("rejects with TRANSCRIPTION_FAILED when the Worker emits an error event", async () => {
    const spy = silenceConsoleError()
    try {
      const fake = new FakeWorker()
      const pending = transcribeLocal(shortAudio(), {
        durationMs: 1000,
        workerFactory: () => fake,
      })
      // Red, CSP o una excepción al evaluar el módulo del Worker: no llegará
      // NINGÚN `message`, así que sin este listener la promesa colgaría.
      fake.emitError("import del módulo del Worker falló")

      await expect(pending).rejects.toBeInstanceOf(TranscriptionError)
      await expect(pending).rejects.toMatchObject({
        code: "TRANSCRIPTION_FAILED",
        message: "No se pudo transcribir el audio.",
      })
      await expect(pending).rejects.toHaveProperty(
        "message",
        expect.not.stringMatching(
          /onnx|huggingface|transformers|jsdelivr|pipeline|dtype|q4|q8|ORT|worker|\.onnx|models\//i,
        ),
      )
      expect(fake.terminateCalls).toBe(1)
      expect(fake.removed).toHaveLength(2) // listeners "message" + "error"
      expect(fake.listenerCount).toBe(0)
      expect(spy).toHaveBeenCalledWith(
        "[transcribe-local] el Worker falló",
        "import del módulo del Worker falló",
      )
    } finally {
      spy.mockRestore()
    }
  })

  it("ignores messages that arrive after the Worker settled", async () => {
    const fake = new FakeWorker()
    const values: number[] = []

    const pending = transcribeLocal(shortAudio(), {
      durationMs: 1000,
      onProgress: (value) => values.push(value),
      workerFactory: () => fake,
    })
    fake.emit({ type: "progress", progress: 0.4 })
    fake.emit({ type: "result", device: "webgpu", segments: [] })
    await pending
    const emittedBeforeSettle = values.length

    expect(() => {
      fake.emit({ type: "progress", progress: 0.9 })
      fake.emit({ type: "result", device: "wasm", segments: [] })
      fake.emit("basura")
    }).not.toThrow()
    expect(values).toHaveLength(emittedBeforeSettle)
    expect(values.at(-1)).toBe(1)
    expect(fake.terminateCalls).toBe(1)
    expect(fake.listenerCount).toBe(0) // retirado: ni siquiera se invoca
  })

  it("logs the technical detail to console.error in development only", async () => {
    const spy = silenceConsoleError()
    try {
      const errorWorker = new FakeWorker()
      const failed = transcribeLocal(shortAudio(), {
        durationMs: 1000,
        workerFactory: () => errorWorker,
      })
      errorWorker.emit({ type: "error", code: "TRANSCRIPTION_FAILED" })
      await expect(failed).rejects.toBeInstanceOf(TranscriptionError)

      const garbageWorker = new FakeWorker()
      const garbage = transcribeLocal(shortAudio(), {
        durationMs: 1000,
        workerFactory: () => garbageWorker,
      })
      garbageWorker.emit({ type: "progress", progress: Number.NaN })
      await expect(garbage).rejects.toBeInstanceOf(TranscriptionError)

      const brokenWorker = new FakeWorker()
      brokenWorker.postShouldThrow = true
      const broken = transcribeLocal(shortAudio(), {
        durationMs: 1000,
        workerFactory: () => brokenWorker,
      })
      await expect(broken).rejects.toBeInstanceOf(TranscriptionError)

      expect(spy).toHaveBeenCalledTimes(3)
      expect(spy.mock.calls.map((call) => call[0])).toEqual([
        "[transcribe-local] el Worker devolvió TRANSCRIPTION_FAILED",
        "[transcribe-local] mensaje no reconocido del Worker",
        "[transcribe-local] no se pudo enviar la petición al Worker",
      ])
    } finally {
      spy.mockRestore()
    }
  })

  it("creates the production Worker lazily when no factory is injected", async () => {
    const created: Array<{ url: string; type: string | undefined }> = []

    class GlobalWorkerFake extends FakeWorker {
      constructor(url: URL | string, options?: { type?: string }) {
        super()
        created.push({ url: String(url), type: options?.type })
      }

      postMessage(message: TranscribeRequest, transfer?: Transferable[]): void {
        super.postMessage(message, transfer)
        this.emit({ type: "result", device: "webgpu", segments: [] })
      }
    }

    vi.stubGlobal("Worker", GlobalWorkerFake)
    try {
      const segments = await transcribeLocal(shortAudio(), { durationMs: 1000 })

      expect(segments).toEqual([])
      expect(created).toHaveLength(1)
      expect(created[0]?.url).toContain("transcribe.worker.ts")
      expect(created[0]?.type).toBe("module")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("produces generic Spanish errors without technical detail", () => {
    const failed = new TranscriptionError()
    expect(failed).toBeInstanceOf(Error)
    expect(failed.name).toBe("TranscriptionError")
    expect(failed.code).toBe("TRANSCRIPTION_FAILED")
    expect(failed.message).toBe("No se pudo transcribir el audio.")
    expect(failed.message).not.toMatch(
      /onnx|huggingface|transformers|jsdelivr|pipeline|dtype|q4|q8|worker|model|\.onnx|models\//i,
    )

    const aborted = new TranscriptionAbortedError()
    expect(aborted).toBeInstanceOf(Error)
    expect(aborted.name).toBe("TranscriptionAbortedError")
    expect(aborted.code).toBe("ABORTED")
    expect(aborted.message).toBe("La transcripción fue cancelada.")
    expect(aborted.message).not.toMatch(/signal|abort\(|worker|terminate/i)

    const noAudio = new TranscriptionNoAudioError()
    expect(noAudio).toBeInstanceOf(Error)
    expect(noAudio.name).toBe("TranscriptionNoAudioError")
    expect(noAudio.code).toBe("NO_AUDIO")
    expect(noAudio.message).toBe("No hay audio para transcribir.")
    expect(noAudio.message).not.toMatch(/audio\.length|durationMs|Float32Array/i)
  })
})
