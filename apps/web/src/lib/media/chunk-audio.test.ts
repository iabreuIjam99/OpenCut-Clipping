import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { probeMatroska } from "../clipping/media-guard"
import {
  ChunkingError,
  type ChunkRange,
  chunkAudio,
  mergeTranscripts,
  planChunks,
} from "./chunk-audio"
import type { AudioExtractionRuntime } from "./ffmpeg-runtime"
import type { TranscriptSegment } from "./transcript"

/**
 * Task 11 tests: pure planning/merge run directly in jsdom, the real cutter
 * runs against an injected fake runtime (jsdom cannot execute the WASM core).
 *
 * Fixture `clip-5s-audio.webm` was generated once with the spike's
 * ffmpeg-static binary; the exact command lives in `__fixtures__/README.md`.
 * `./ffmpeg-runtime` is mocked only to observe the production factory, and the
 * Task 9 probe is wrapped to count its calls and to simulate its failures.
 */

const { createFfmpegRuntimeSpy } = vi.hoisted(() => ({
  createFfmpegRuntimeSpy: vi.fn(),
}))

vi.mock("./ffmpeg-runtime", () => ({
  createFfmpegRuntime: createFfmpegRuntimeSpy,
}))

vi.mock("../clipping/media-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../clipping/media-guard")>()
  return { ...actual, probeMatroska: vi.fn(actual.probeMatroska) }
})

// ---------------------------------------------------------------------------
// Fake runtime
// ---------------------------------------------------------------------------

class FakeRuntime implements AudioExtractionRuntime {
  readonly log: string[] = []
  readonly mountCalls: Array<{ path: string; file: File }> = []
  readonly execArgs: string[][] = []
  terminateCalls = 0
  loadShouldFail = false
  mountResult = true
  execResult = 0
  readFileResult: Uint8Array | string = new Uint8Array([9])
  /** Los pasos de limpieza (unmount/deleteDir) fallan: el worker ya no existe. */
  failCleanup = false
  failTerminate = false

  onProgress(): void {}

  async load(): Promise<void> {
    this.log.push("load")
    if (this.loadShouldFail) throw new Error("fallo al cargar el core")
  }

  async createDir(path: string): Promise<void> {
    this.log.push(`createDir:${path}`)
  }

  async mount(file: File, path: string): Promise<boolean> {
    this.log.push(`mount:${path}:${file.name}`)
    this.mountCalls.push({ path, file })
    return this.mountResult
  }

  async exec(args: readonly string[]): Promise<number> {
    this.log.push("exec")
    this.execArgs.push([...args])
    return this.execResult
  }

  async readFile(path: string): Promise<Uint8Array | string> {
    this.log.push(`readFile:${path}`)
    return this.readFileResult
  }

  async deleteFile(path: string): Promise<void> {
    this.log.push(`deleteFile:${path}`)
  }

  async deleteDir(path: string): Promise<void> {
    this.log.push(`deleteDir:${path}`)
    if (this.failCleanup) throw new Error("deleteDir falló")
  }

  async unmount(path: string): Promise<void> {
    this.log.push(`unmount:${path}`)
    if (this.failCleanup) throw new Error("unmount falló")
  }

  terminate(): void {
    this.log.push("terminate")
    this.terminateCalls++
    if (this.failTerminate) throw new Error("terminate falló")
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const audioBlob = (): Blob =>
  new Blob(
    [
      new Uint8Array(
        readFileSync(resolve(process.cwd(), "src/lib/media/__fixtures__/clip-5s-audio.webm")),
      ),
    ],
    { type: "audio/webm" },
  )

const seg = (startMs: number, endMs: number, text: string): TranscriptSegment => ({
  startMs,
  endMs,
  text,
})

/** Awaits a rejection and returns it narrowed to `ChunkingError`. */
async function rejection(promise: Promise<unknown>): Promise<ChunkingError> {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  )
  if (error instanceof ChunkingError) return error
  throw new Error("se esperaba un ChunkingError")
}

const probeSpy = vi.mocked(probeMatroska)

beforeEach(() => {
  probeSpy.mockClear()
  createFfmpegRuntimeSpy.mockClear()
  createFfmpegRuntimeSpy.mockImplementation(() => new FakeRuntime())
})

// ---------------------------------------------------------------------------
// Scenarios (1:1 with features/segmentacion.feature)
// ---------------------------------------------------------------------------

describe("planChunks (escenarios)", () => {
  it("Scenario: Planificar 1 h en segmentos de 30 min con 2 s de solape", () => {
    const ranges = planChunks({
      durationMs: 3_600_000,
      bytes: 10_800_000,
      maxBytes: 5_400_000,
      overlapMs: 2_000,
    })

    expect(ranges).toEqual([
      { startMs: 0, endMs: 1_800_000 },
      { startMs: 1_798_000, endMs: 3_598_000 },
      { startMs: 3_596_000, endMs: 3_600_000 },
    ])
    for (let index = 1; index < ranges.length; index++) {
      expect(ranges[index - 1].endMs - ranges[index].startMs).toBe(2_000)
    }
    expect(ranges.at(-1)?.endMs).toBe(3_600_000)
  })

  it("Scenario: Un audio más corto que el límite → un solo segmento", () => {
    const ranges = planChunks({
      durationMs: 60_000,
      bytes: 180_000,
      maxBytes: 5_400_000,
      overlapMs: 2_000,
    })

    expect(ranges).toEqual([{ startMs: 0, endMs: 60_000 }])
  })

  it("Scenario: El límite de bytes nunca se supera (estimación)", () => {
    const cases = [
      { durationMs: 3_600_000, bytes: 10_800_000, maxBytes: 5_400_000, overlapMs: 2_000 },
      { durationMs: 3_600_000, bytes: 10_800_000, maxBytes: 700_000, overlapMs: 0 },
      { durationMs: 123_457, bytes: 999_999, maxBytes: 123_457, overlapMs: 5_000 },
      { durationMs: 5_008, bytes: 17_135, maxBytes: 6_000, overlapMs: 500 },
    ]

    for (const input of cases) {
      const bytesPerMs = input.bytes / input.durationMs
      const ranges = planChunks(input)

      expect(ranges[0].startMs).toBe(0)
      expect(ranges.at(-1)?.endMs).toBe(input.durationMs)
      for (const [index, range] of ranges.entries()) {
        expect(Math.ceil((range.endMs - range.startMs) * bytesPerMs)).toBeLessThanOrEqual(
          input.maxBytes + 1,
        )
        if (index > 0) {
          const previous = ranges[index - 1]
          expect(range.startMs).toBeLessThanOrEqual(previous.endMs)
          expect(previous.endMs - range.startMs).toBe(input.overlapMs)
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Additional tests (brief R1, R4)
// ---------------------------------------------------------------------------

describe("planChunks (detalles)", () => {
  it("plans contiguous ranges without overlap when overlapMs is 0", () => {
    const ranges = planChunks({
      durationMs: 3_600_000,
      bytes: 10_800_000,
      maxBytes: 1_000_000,
      overlapMs: 0,
    })

    expect(ranges[0]).toEqual({ startMs: 0, endMs: 333_333 })
    for (let index = 1; index < ranges.length; index++) {
      expect(ranges[index].startMs).toBe(ranges[index - 1].endMs)
    }
    expect(ranges.at(-1)?.endMs).toBe(3_600_000)
  })

  it("rejects invalid inputs with ChunkingError", () => {
    const invalid = [
      { durationMs: 0, bytes: 1_000, maxBytes: 1_000, overlapMs: 0 },
      { durationMs: -1, bytes: 1_000, maxBytes: 1_000, overlapMs: 0 },
      { durationMs: 1_000, bytes: 0, maxBytes: 1_000, overlapMs: 0 },
      { durationMs: 1_000, bytes: 1_000, maxBytes: 0, overlapMs: 0 },
      { durationMs: 1_000, bytes: 1_000, maxBytes: 1_000, overlapMs: -1 },
      { durationMs: Number.NaN, bytes: 1_000, maxBytes: 1_000, overlapMs: 0 },
      { durationMs: Number.POSITIVE_INFINITY, bytes: 1_000, maxBytes: 1_000, overlapMs: 0 },
      { durationMs: 1_000, bytes: Number.NaN, maxBytes: 1_000, overlapMs: 0 },
      { durationMs: 1_000, bytes: 1_000, maxBytes: Number.POSITIVE_INFINITY, overlapMs: 0 },
      { durationMs: 1_000, bytes: 1_000, maxBytes: 1_000, overlapMs: Number.NaN },
    ]

    for (const input of invalid) {
      expect(() => planChunks(input)).toThrowError(ChunkingError)
    }
  })

  it("rejects a maxBytes too small for the overlap", () => {
    expect(() =>
      planChunks({ durationMs: 10_000, bytes: 10_000, maxBytes: 4_000, overlapMs: 2_000 }),
    ).toThrowError(ChunkingError)
  })

  it("rejects a computed chunkMs that is not finite or not positive", () => {
    // Subdesbordamiento de bytesPerMs: maxBytes / bytesPerMs = Infinity.
    expect(() =>
      planChunks({
        durationMs: Number.MAX_VALUE,
        bytes: Number.MIN_VALUE,
        maxBytes: 1,
        overlapMs: 0,
      }),
    ).toThrowError(ChunkingError)
    // Exceso de bytes por milisegundo: chunkMs = 0.
    expect(() =>
      planChunks({ durationMs: 1, bytes: 1_000_000_000, maxBytes: 1, overlapMs: 0 }),
    ).toThrowError(ChunkingError)
  })

  it("rejects a plan whose float precision stalls the loop", () => {
    // Con este plan chunkMs = 1: a partir de 2^53, start + 1 === start en
    // IEEE-754. La cota MAX_CHUNKS corta el bucle en tiempo normal de test.
    expect(() =>
      planChunks({ durationMs: 1e300, bytes: 1, maxBytes: 1e-300, overlapMs: 0 }),
    ).toThrowError(ChunkingError)
  })

  it("plans a 3 h upload well under the range cap", () => {
    const ranges = planChunks({
      durationMs: 10_800_000,
      bytes: 35_700_000,
      maxBytes: 5_400_000,
      overlapMs: 2_000,
    })

    expect(ranges.length).toBeLessThan(10_000)
    expect(ranges.length).toBeLessThanOrEqual(10)
    expect(ranges[0].startMs).toBe(0)
    expect(ranges.at(-1)?.endMs).toBe(10_800_000)
  })
})

describe("chunkAudio", () => {
  it("returns a single 5 s chunk for the fixture with a 1 MB limit", async () => {
    const blob = audioBlob()
    const { durationMs } = await probeMatroska(blob)
    const runtime = new FakeRuntime()

    const chunks = await chunkAudio(blob, { maxBytes: 1_000_000, overlapMs: 2_000, runtime })

    expect(durationMs).toBeGreaterThanOrEqual(4_800)
    expect(durationMs).toBeLessThanOrEqual(5_200)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].offsetMs).toBe(0)
    expect(chunks[0].blob.type).toBe("audio/webm")
    expect(chunks[0].blob.size).toBeGreaterThan(0)
    expect(runtime.mountCalls).toHaveLength(1)
    expect(runtime.execArgs[0]).toContain(String(durationMs / 1000))
  })

  it("uses the injected cut with the exact planned ranges and offsets", async () => {
    const blob = audioBlob()
    const calls: ChunkRange[] = []
    const cut = vi.fn(async (source: Blob, startMs: number, endMs: number) => {
      expect(source).toBe(blob)
      calls.push({ startMs, endMs })
      return new Blob([new Uint8Array([7])], { type: "audio/webm" })
    })

    const chunks = await chunkAudio(blob, { maxBytes: 10_000, overlapMs: 1_000, cut })

    const { durationMs } = await probeMatroska(blob)
    const expected = planChunks({
      durationMs,
      bytes: blob.size,
      maxBytes: 10_000,
      overlapMs: 1_000,
    })
    expect(expected.length).toBeGreaterThan(1)
    expect(calls).toEqual(expected)
    expect(cut).toHaveBeenCalledTimes(expected.length)
    expect(chunks.map((chunk) => chunk.offsetMs)).toEqual(expected.map((range) => range.startMs))
    expect(chunks.every((chunk) => chunk.blob.type === "audio/webm")).toBe(true)
    expect(createFfmpegRuntimeSpy).not.toHaveBeenCalled()
  })

  it("cuts every range with one mount, the exact -c copy args and full cleanup", async () => {
    const blob = audioBlob()
    const { durationMs } = await probeMatroska(blob)
    const ranges = planChunks({ durationMs, bytes: blob.size, maxBytes: 10_000, overlapMs: 1_000 })
    expect(ranges.length).toBeGreaterThan(1)
    const runtime = new FakeRuntime()

    const chunks = await chunkAudio(blob, { maxBytes: 10_000, overlapMs: 1_000, runtime })

    expect(chunks).toHaveLength(ranges.length)
    expect(runtime.mountCalls).toHaveLength(1)
    expect(runtime.mountCalls[0].path).toBe("/input")
    expect(runtime.mountCalls[0].file.name).toBe("audio.webm")
    expect(runtime.execArgs).toEqual(
      ranges.map((range) => [
        "-ss",
        String(range.startMs / 1000),
        "-i",
        "/input/audio.webm",
        "-t",
        String((range.endMs - range.startMs) / 1000),
        "-c",
        "copy",
        "-f",
        "webm",
        "/output/chunk.webm",
      ]),
    )
    expect(runtime.log).toEqual([
      "load",
      "createDir:/input",
      "mount:/input:audio.webm",
      "createDir:/output",
      ...ranges.flatMap(() => [
        "exec",
        "readFile:/output/chunk.webm",
        "deleteFile:/output/chunk.webm",
      ]),
      "unmount:/input",
      "deleteDir:/input",
      "deleteDir:/output",
      "terminate",
    ])
    expect(runtime.terminateCalls).toBe(1)
  })

  it("reads the duration from probeMatroska instead of estimating it", async () => {
    const blob = audioBlob()
    probeSpy.mockResolvedValueOnce({ container: "webm", durationMs: 10_000, hasAudio: true })
    const runtime = new FakeRuntime()

    await chunkAudio(blob, { maxBytes: 1_000_000, overlapMs: 2_000, runtime })

    expect(probeSpy).toHaveBeenCalledWith(blob)
    expect(runtime.execArgs[0]).toEqual([
      "-ss",
      "0",
      "-i",
      "/input/audio.webm",
      "-t",
      "10",
      "-c",
      "copy",
      "-f",
      "webm",
      "/output/chunk.webm",
    ])
  })

  it("rejects non-Matroska bytes without creating a runtime", async () => {
    const garbage = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])])

    await expect(
      chunkAudio(garbage, { maxBytes: 1_000_000, overlapMs: 2_000 }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_AUDIO" })
    expect(createFfmpegRuntimeSpy).not.toHaveBeenCalled()
  })

  it("rejects when the probe reports no usable duration", async () => {
    probeSpy.mockResolvedValueOnce({ container: "webm", durationMs: 0, hasAudio: true })

    await expect(
      chunkAudio(audioBlob(), { maxBytes: 1_000_000, overlapMs: 2_000 }),
    ).rejects.toBeInstanceOf(ChunkingError)
    expect(createFfmpegRuntimeSpy).not.toHaveBeenCalled()
  })

  it("rejects a non-finite probed duration without creating a runtime", async () => {
    probeSpy.mockResolvedValueOnce({ container: "webm", durationMs: Number.NaN, hasAudio: true })

    await expect(
      chunkAudio(audioBlob(), { maxBytes: 1_000_000, overlapMs: 2_000 }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_AUDIO" })
    expect(createFfmpegRuntimeSpy).not.toHaveBeenCalled()
  })

  it("maps a failing probe to ChunkingError and logs the detail in development only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      probeSpy.mockRejectedValueOnce(new Error("fallo interno de sonda"))

      const error = await rejection(
        chunkAudio(audioBlob(), { maxBytes: 1_000_000, overlapMs: 2_000 }),
      )

      expect(error.code).toBe("UNSUPPORTED_AUDIO")
      expect(error.message).not.toMatch(/sonda|fallo|probe/i)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0]?.[0]).toBe("[chunk-audio] sonda de contenedor fallida")
      expect(String(spy.mock.calls[0]?.[1])).toContain("fallo interno de sonda")
    } finally {
      spy.mockRestore()
    }
  })

  it("maps a string readFile to ChunkingError with full cleanup", async () => {
    const runtime = new FakeRuntime()
    runtime.readFileResult = "salida en texto"

    const error = await rejection(
      chunkAudio(audioBlob(), { maxBytes: 1_000_000, overlapMs: 2_000, runtime }),
    )

    expect(error.code).toBe("UNSUPPORTED_AUDIO")
    expect(error.message).not.toMatch(/salida|readFile|output/i)
    expect(runtime.log).toContain("unmount:/input")
    expect(runtime.log).toContain("deleteDir:/input")
    expect(runtime.log).toContain("deleteDir:/output")
    expect(runtime.log).toContain("terminate")
    expect(runtime.terminateCalls).toBe(1)
  })

  it("maps a failed exec to ChunkingError and logs the detail in development only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const runtime = new FakeRuntime()
      runtime.execResult = 1

      const error = await rejection(
        chunkAudio(audioBlob(), { maxBytes: 1_000_000, overlapMs: 2_000, runtime }),
      )

      expect(error.code).toBe("UNSUPPORTED_AUDIO")
      expect(error.message).toBe("No se pudo segmentar el audio.")
      expect(error.message).not.toMatch(/ffmpeg|exit|input|output|code/i)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0]?.[0]).toBe("[chunk-audio] segmentacion fallida")
      expect(String(spy.mock.calls[0]?.[1])).toContain("exit code 1")
      expect(runtime.log).toContain("unmount:/input")
      expect(runtime.log).toContain("terminate")
    } finally {
      spy.mockRestore()
    }
  })

  it("maps a refused mount to ChunkingError without executing", async () => {
    const runtime = new FakeRuntime()
    runtime.mountResult = false

    const error = await rejection(
      chunkAudio(audioBlob(), { maxBytes: 1_000_000, overlapMs: 2_000, runtime }),
    )

    expect(error.code).toBe("UNSUPPORTED_AUDIO")
    expect(runtime.execArgs).toHaveLength(0)
    expect(runtime.log).toContain("unmount:/input")
    expect(runtime.log).toContain("terminate")
  })

  it("maps a failed load to ChunkingError without mounting", async () => {
    const runtime = new FakeRuntime()
    runtime.loadShouldFail = true

    const error = await rejection(
      chunkAudio(audioBlob(), { maxBytes: 1_000_000, overlapMs: 2_000, runtime }),
    )

    expect(error.code).toBe("UNSUPPORTED_AUDIO")
    expect(runtime.mountCalls).toHaveLength(0)
    expect(runtime.log).toContain("terminate")
  })

  it("keeps the result and the original error when cleanup fails", async () => {
    const succeeding = new FakeRuntime()
    succeeding.failCleanup = true
    succeeding.failTerminate = true
    const chunks = await chunkAudio(audioBlob(), {
      maxBytes: 1_000_000,
      overlapMs: 2_000,
      runtime: succeeding,
    })
    expect(chunks).toHaveLength(1)
    expect(succeeding.terminateCalls).toBe(1)

    const failing = new FakeRuntime()
    failing.failCleanup = true
    failing.execResult = 1
    const error = await rejection(
      chunkAudio(audioBlob(), { maxBytes: 1_000_000, overlapMs: 2_000, runtime: failing }),
    )
    expect(error.code).toBe("UNSUPPORTED_AUDIO")
    expect(error.message).not.toMatch(/deleteDir|unmount|fallo/i)
  })

  it("creates the production runtime when no runtime is injected", async () => {
    const chunks = await chunkAudio(audioBlob(), { maxBytes: 1_000_000, overlapMs: 2_000 })

    expect(createFfmpegRuntimeSpy).toHaveBeenCalledTimes(1)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].blob.size).toBeGreaterThan(0)
  })

  it("produces a generic Spanish message without technical detail", () => {
    const error = new ChunkingError()
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("ChunkingError")
    expect(error.code).toBe("UNSUPPORTED_AUDIO")
    expect(error.message).toBe("No se pudo segmentar el audio.")
    expect(error.message).not.toMatch(/ffmpeg|exit|input|output|probe|sonda/i)
  })
})

// ---------------------------------------------------------------------------
// Scenarios (1:1 with features/segmentacion.feature)
// ---------------------------------------------------------------------------

describe("mergeTranscripts (escenarios)", () => {
  it("Scenario: Dos chunks con 2 s de solape y texto equivalente → el merge no duplica", () => {
    const merged = mergeTranscripts([
      [seg(0, 2_000, "Uno, dos."), seg(2_000, 5_000, "¿Cómo estás, amigo?")],
      [seg(3_000, 6_000, "¡Como estas amigo!"), seg(6_000, 8_000, "Yo bien.")],
    ])

    expect(merged).toEqual([
      seg(0, 2_000, "Uno, dos."),
      seg(2_000, 5_000, "¿Cómo estás, amigo?"),
      seg(6_000, 8_000, "Yo bien."),
    ])
  })

  it("Scenario: Una repetición legítima en tiempos distintos → se conserva", () => {
    const merged = mergeTranscripts([[seg(0, 3_000, "Adiós")], [seg(10_000, 13_000, "Adiós")]])

    expect(merged).toEqual([seg(0, 3_000, "Adiós"), seg(10_000, 13_000, "Adiós")])
  })
})

// ---------------------------------------------------------------------------
// Additional tests (brief R3)
// ---------------------------------------------------------------------------

describe("mergeTranscripts (detalles)", () => {
  it("returns an empty list for empty input", () => {
    expect(mergeTranscripts([])).toEqual([])
    expect(mergeTranscripts([[], []])).toEqual([])
    expect(mergeTranscripts([[], [seg(0, 1_000, "hola")]])).toEqual([seg(0, 1_000, "hola")])
  })

  it("passes a single chunk through unchanged", () => {
    expect(mergeTranscripts([[seg(0, 1_000, "hola"), seg(2_000, 3_000, "mundo")]])).toEqual([
      seg(0, 1_000, "hola"),
      seg(2_000, 3_000, "mundo"),
    ])
  })

  it("sorts unordered chunks and segments by startMs", () => {
    expect(mergeTranscripts([[seg(5_000, 6_000, "b")], [seg(0, 1_000, "a")]])).toEqual([
      seg(0, 1_000, "a"),
      seg(5_000, 6_000, "b"),
    ])
    expect(
      mergeTranscripts([[seg(3_000, 4_000, "c"), seg(0, 1_000, "a"), seg(1_500, 2_500, "b")]]),
    ).toEqual([seg(0, 1_000, "a"), seg(1_500, 2_500, "b"), seg(3_000, 4_000, "c")])
  })

  it("drops temporal duplicates up to previousEndMs + 250", () => {
    const merged = mergeTranscripts([
      [seg(0, 4_000, "primero")],
      [seg(1_500, 4_000, "primero"), seg(1_000, 4_250, "segundo"), seg(2_000, 4_251, "tercero")],
    ])

    expect(merged).toEqual([seg(0, 4_000, "primero"), seg(2_000, 4_251, "tercero")])
  })

  it("skips similarity checks when the temporal filter removed every segment", () => {
    const merged = mergeTranscripts([[seg(0, 4_000, "uno")], [seg(2_000, 4_000, "uno")]])

    expect(merged).toEqual([seg(0, 4_000, "uno")])
  })

  it("keeps similar text that starts beyond the 2500 ms window", () => {
    const merged = mergeTranscripts([[seg(0, 4_000, "hola")], [seg(6_500, 9_000, "hola")]])

    expect(merged).toEqual([seg(0, 4_000, "hola"), seg(6_500, 9_000, "hola")])
  })

  it("deduplicates the two largest overlapping segments", () => {
    const merged = mergeTranscripts([
      [seg(0, 2_000, "hola"), seg(2_000, 5_000, "mundo cruel")],
      [seg(3_000, 5_500, "hola"), seg(5_500, 7_000, "mundo cruel"), seg(7_000, 8_000, "nuevo")],
    ])

    expect(merged).toEqual([
      seg(0, 2_000, "hola"),
      seg(2_000, 5_000, "mundo cruel"),
      seg(7_000, 8_000, "nuevo"),
    ])
  })

  it("drops segments whose normalized text is empty", () => {
    const merged = mergeTranscripts([[seg(0, 3_000, "  ,,, !!! ")], [seg(3_500, 5_000, "hola")]])

    expect(merged).toEqual([seg(3_500, 5_000, "hola")])
  })
})
