import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MediaValidationError, validateMediaFile } from "../clipping/media-guard"
import { AbortedError, AudioExtractionError, extractAudio } from "./extract-audio"
import type { AudioExtractionRuntime } from "./ffmpeg-runtime"

/**
 * Orchestration tests run against an injected fake runtime: jsdom cannot
 * execute the ffmpeg.wasm core (R5). `./ffmpeg-runtime` is mocked only to
 * observe whether the production factory is created, and the Task 9 guard is
 * wrapped to count its calls (it must run exactly once per extraction).
 *
 * Fixture `clip-5s.mp4` was generated once with the spike's ffmpeg-static
 * binary; the exact command lives in `__fixtures__/README.md`.
 */

const { createFfmpegRuntimeSpy } = vi.hoisted(() => ({
  createFfmpegRuntimeSpy: vi.fn(),
}))

vi.mock("./ffmpeg-runtime", () => ({
  createFfmpegRuntime: createFfmpegRuntimeSpy,
}))

vi.mock("../clipping/media-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../clipping/media-guard")>()
  return { ...actual, validateMediaFile: vi.fn(actual.validateMediaFile) }
})

// ---------------------------------------------------------------------------
// Fake runtime
// ---------------------------------------------------------------------------

class FakeRuntime implements AudioExtractionRuntime {
  readonly log: string[] = []
  readonly mountCalls: Array<{ path: string; file: File }> = []
  readonly execArgs: string[][] = []
  readonly readFileCalls: string[] = []
  terminateCalls = 0
  loadShouldFail = false
  mountResult = true
  execResult = 0
  /** Progress values emitted by the fake while `exec` runs. */
  execProgress: number[] = []
  readFileResult: Uint8Array | string = new Uint8Array([9])
  /** Every cleanup operation throws (the worker is already gone). */
  failCleanup = false
  failTerminate = false
  /** `exec` stays pending until `terminate()` (worker killed mid-run). */
  abortDuringExec = false
  private progressCb: ((p: number) => void) | null = null
  private pendingExec: ((reason: Error) => void) | null = null

  onProgress(cb: (p: number) => void): void {
    this.log.push("onProgress")
    this.progressCb = cb
  }

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
    for (const value of this.execProgress) this.progressCb?.(value)
    if (this.abortDuringExec) {
      return new Promise<number>((_resolve, reject) => {
        this.pendingExec = reject
      })
    }
    return this.execResult
  }

  async readFile(path: string): Promise<Uint8Array | string> {
    this.log.push(`readFile:${path}`)
    this.readFileCalls.push(path)
    return this.readFileResult
  }

  async deleteFile(path: string): Promise<void> {
    this.log.push(`deleteFile:${path}`)
    if (this.failCleanup) throw new Error("deleteFile falló")
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
    this.pendingExec?.(new Error("worker terminado"))
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fixtureBytes = (dir: string, name: string): Uint8Array =>
  new Uint8Array(readFileSync(resolve(process.cwd(), dir, name)))

const clip = (): Uint8Array => fixtureBytes("src/lib/media/__fixtures__", "clip-5s.mp4")
const noAudioClip = (): Uint8Array => fixtureBytes("src/lib/clipping/__fixtures__", "no-audio.mp4")

function makeFile(data: Uint8Array, type = "video/mp4", name = "clip.mp4"): File {
  return new File([new Uint8Array(data)], name, { type })
}

/** Awaits a rejection and returns it narrowed to `AudioExtractionError`. */
async function rejection(promise: Promise<unknown>): Promise<AudioExtractionError> {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  )
  if (error instanceof AudioExtractionError) return error
  throw new Error("se esperaba un AudioExtractionError")
}

const guardSpy = vi.mocked(validateMediaFile)

beforeEach(() => {
  guardSpy.mockClear()
  createFfmpegRuntimeSpy.mockClear()
  createFfmpegRuntimeSpy.mockImplementation(() => new FakeRuntime())
})

// ---------------------------------------------------------------------------
// Scenarios (1:1 with features/extraccion-audio.feature)
// ---------------------------------------------------------------------------

describe("extractAudio", () => {
  it("Scenario: Extraer audio de un MP4 de 5 s", async () => {
    const runtime = new FakeRuntime()
    runtime.execProgress = [0.25, 0.6]
    const values: number[] = []

    const result = await extractAudio(makeFile(clip()), {
      runtime,
      onProgress: (p) => values.push(p),
    })

    expect(result.codec).toBe("opus")
    expect(result.blob.type).toBe("audio/webm")
    expect(result.blob.size).toBeGreaterThan(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(4800)
    expect(result.durationMs).toBeLessThanOrEqual(5200)

    expect(values[0]).toBe(0)
    expect(values.at(-1)).toBe(1)
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1] as number)
    }
    expect(values.every((p) => p >= 0 && p <= 1)).toBe(true)
  })

  it("Scenario: Cancelar con AbortSignal", async () => {
    const runtime = new FakeRuntime()
    runtime.abortDuringExec = true
    const controller = new AbortController()

    const pending = extractAudio(makeFile(clip()), { runtime, signal: controller.signal })
    await vi.waitFor(() => expect(runtime.execArgs).toHaveLength(1))
    controller.abort()

    await expect(pending).rejects.toBeInstanceOf(AbortedError)
    expect(runtime.terminateCalls).toBe(1)
    expect(runtime.log.some((entry) => entry.startsWith("delete"))).toBe(false)
    expect(runtime.log.some((entry) => entry.startsWith("unmount"))).toBe(false)
  })

  it("Scenario: ffmpeg falla (exit != 0)", async () => {
    const runtime = new FakeRuntime()
    runtime.execResult = 1

    const error = await rejection(extractAudio(makeFile(clip()), { runtime }))

    expect(error.code).toBe("EXTRACTION_FAILED")
    expect(error).toBeInstanceOf(AudioExtractionError)
    expect(runtime.log).toContain("deleteFile:/output/audio.webm")
    expect(runtime.log).toContain("deleteDir:/output")
    expect(runtime.log).toContain("unmount:/input")
    expect(runtime.log).toContain("deleteDir:/input")
    expect(runtime.log).toContain("terminate")
    expect(error.message).not.toMatch(/exit|ffmpeg|code|input|output/i)
  })
})

// ---------------------------------------------------------------------------
// Additional tests (brief R9)
// ---------------------------------------------------------------------------

describe("extractAudio (detalles)", () => {
  it("uses the exact ADR-02 command and the fixed WORKERFS paths", async () => {
    const runtime = new FakeRuntime()
    const source = makeFile(clip())

    await extractAudio(source, { runtime })

    expect(runtime.execArgs).toEqual([
      [
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
      ],
    ])
    expect(runtime.mountCalls).toHaveLength(1)
    expect(runtime.mountCalls[0]?.path).toBe("/input")
    expect(runtime.mountCalls[0]?.file.name).toBe("input.bin")
    expect(runtime.mountCalls[0]?.file.size).toBe(source.size)
    expect(runtime.readFileCalls).toEqual(["/output/audio.webm"])
    expect(runtime.log).toEqual([
      "onProgress",
      "load",
      "createDir:/input",
      "createDir:/output",
      "mount:/input:input.bin",
      "exec",
      "readFile:/output/audio.webm",
      "deleteFile:/output/audio.webm",
      "deleteDir:/output",
      "unmount:/input",
      "deleteDir:/input",
      "terminate",
    ])
  })

  it("clamps out-of-range progress to 0 and 1", async () => {
    const runtime = new FakeRuntime()
    runtime.execProgress = [-0.2, 1.4]
    const values: number[] = []

    await extractAudio(makeFile(clip()), { runtime, onProgress: (p) => values.push(p) })

    expect(values).toEqual([0, 0, 1, 1])
  })

  it("maps a false mount to EXTRACTION_FAILED with full cleanup", async () => {
    const runtime = new FakeRuntime()
    runtime.mountResult = false

    await expect(extractAudio(makeFile(clip()), { runtime })).rejects.toMatchObject({
      code: "EXTRACTION_FAILED",
    })
    expect(runtime.log).toContain("deleteFile:/output/audio.webm")
    expect(runtime.log).toContain("unmount:/input")
    expect(runtime.log).toContain("terminate")
    expect(runtime.execArgs).toHaveLength(0)
  })

  it("maps a string readFile to EXTRACTION_FAILED with full cleanup", async () => {
    const runtime = new FakeRuntime()
    runtime.readFileResult = "salida en texto"

    await expect(extractAudio(makeFile(clip()), { runtime })).rejects.toMatchObject({
      code: "EXTRACTION_FAILED",
    })
    expect(runtime.log).toContain("deleteFile:/output/audio.webm")
    expect(runtime.log).toContain("unmount:/input")
    expect(runtime.log).toContain("terminate")
  })

  it("maps a rejected load to EXTRACTION_FAILED without mounting", async () => {
    const runtime = new FakeRuntime()
    runtime.loadShouldFail = true

    await expect(extractAudio(makeFile(clip()), { runtime })).rejects.toMatchObject({
      code: "EXTRACTION_FAILED",
    })
    expect(runtime.mountCalls).toHaveLength(0)
    expect(runtime.log).toContain("terminate")
  })

  it("keeps the result and the original error when cleanup fails", async () => {
    const succeeding = new FakeRuntime()
    succeeding.failCleanup = true
    succeeding.failTerminate = true
    const result = await extractAudio(makeFile(clip()), { runtime: succeeding })
    expect(result.codec).toBe("opus")

    const failing = new FakeRuntime()
    failing.failCleanup = true
    failing.execResult = 1
    const error = await rejection(extractAudio(makeFile(clip()), { runtime: failing }))
    expect(error.code).toBe("EXTRACTION_FAILED")
    expect(error.message).not.toMatch(/deleteFile|unmount|fallo/i)
  })

  it("calls the guard exactly once and reuses its duration", async () => {
    const runtime = new FakeRuntime()

    const result = await extractAudio(makeFile(clip()), { runtime })

    expect(guardSpy).toHaveBeenCalledTimes(1)
    expect(result.durationMs).toBeGreaterThanOrEqual(4800)
    expect(result.durationMs).toBeLessThanOrEqual(5200)
  })

  it("rejects NO_AUDIO_TRACK without creating a runtime", async () => {
    await expect(
      extractAudio(makeFile(noAudioClip(), "video/mp4", "silent.mp4")),
    ).rejects.toMatchObject({ code: "NO_AUDIO_TRACK" })
    await expect(
      extractAudio(makeFile(noAudioClip(), "video/mp4", "silent.mp4")),
    ).rejects.toBeInstanceOf(MediaValidationError)
    expect(createFfmpegRuntimeSpy).not.toHaveBeenCalled()
  })

  it("rejects with AbortedError when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      extractAudio(makeFile(clip()), { signal: controller.signal }),
    ).rejects.toBeInstanceOf(AbortedError)
    expect(createFfmpegRuntimeSpy).not.toHaveBeenCalled()
    expect(guardSpy).not.toHaveBeenCalled()
  })

  it("rejects with AbortedError when the signal aborts during validation", async () => {
    const controller = new AbortController()

    const pending = extractAudio(makeFile(clip()), { signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toBeInstanceOf(AbortedError)
    expect(createFfmpegRuntimeSpy).not.toHaveBeenCalled()
  })

  it("creates the production runtime when no runtime is injected", async () => {
    const result = await extractAudio(makeFile(clip()))

    expect(createFfmpegRuntimeSpy).toHaveBeenCalledTimes(1)
    expect(result.codec).toBe("opus")
    expect(result.blob.size).toBeGreaterThan(0)
  })

  it("logs the technical detail to console.error in development only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const runtime = new FakeRuntime()
      runtime.execResult = 1
      await expect(extractAudio(makeFile(clip()), { runtime })).rejects.toBeInstanceOf(
        AudioExtractionError,
      )

      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0]?.[0]).toBe("[extract-audio] extraccion fallida")
      expect(spy.mock.calls[0]?.[1]).toBeInstanceOf(Error)
      expect(String(spy.mock.calls[0]?.[1])).toContain("exit code 1")
    } finally {
      spy.mockRestore()
    }
  })

  it("produces generic Spanish messages without technical detail", () => {
    const extraction = new AudioExtractionError()
    expect(extraction).toBeInstanceOf(Error)
    expect(extraction.name).toBe("AudioExtractionError")
    expect(extraction.code).toBe("EXTRACTION_FAILED")
    expect(extraction.message).toBe("No se pudo extraer el audio del vídeo.")
    expect(extraction.message).not.toMatch(/ffmpeg|exit|input|output|args/i)

    const aborted = new AbortedError()
    expect(aborted).toBeInstanceOf(Error)
    expect(aborted.name).toBe("AbortedError")
    expect(aborted.code).toBe("ABORTED")
    expect(aborted.message).toBe("La extracción de audio fue cancelada.")
    expect(aborted.message).not.toMatch(/ffmpeg|signal|abort\(/i)
  })
})
