import { beforeEach, describe, expect, it, vi } from "vitest"
import { createFfmpegRuntime } from "./ffmpeg-runtime"

/**
 * Adapter tests: `@ffmpeg/ffmpeg` is mocked with an explicit typed double
 * (jsdom cannot run the WASM core). Production code only ever calls
 * `on("progress", …)`, `load`, `mount`, `exec`, `readFile`, `createDir`,
 * `deleteFile`, `deleteDir`, `unmount` and `terminate` on the instance.
 */

interface FakeProgressEvent {
  readonly progress: number
  readonly time: number
}

type FakeProgressListener = (event: FakeProgressEvent) => void

interface FakeLoadConfig {
  readonly classWorkerURL?: string
  readonly coreURL?: string
  readonly wasmURL?: string
  readonly workerURL?: string
}

interface FakeMountCall {
  readonly fsType: string
  readonly files: readonly File[]
  readonly mountPoint: string
}

const { FakeFFmpeg, created } = vi.hoisted(() => {
  class FakeFFmpeg {
    readonly loadCalls: FakeLoadConfig[] = []
    readonly mountCalls: FakeMountCall[] = []
    readonly execCalls: string[][] = []
    readonly readFileCalls: string[] = []
    readonly createDirCalls: string[] = []
    readonly deleteFileCalls: string[] = []
    readonly deleteDirCalls: string[] = []
    readonly unmountCalls: string[] = []
    readonly onEvents: string[] = []
    terminateCalls = 0
    mountResult = true
    execResult = 0
    readFileResult: Uint8Array | string = new Uint8Array([1, 2, 3])
    private readonly progressListeners: FakeProgressListener[] = []

    constructor() {
      created.push(this)
    }

    on(event: "progress", callback: FakeProgressListener): void {
      this.onEvents.push(event)
      this.progressListeners.push(callback)
    }

    async load(config: FakeLoadConfig): Promise<boolean> {
      this.loadCalls.push(config)
      return true
    }

    async mount(fsType: string, options: { files: File[] }, mountPoint: string): Promise<boolean> {
      this.mountCalls.push({ fsType, files: options.files, mountPoint })
      return this.mountResult
    }

    async exec(args: string[]): Promise<number> {
      this.execCalls.push(args)
      return this.execResult
    }

    async readFile(path: string): Promise<Uint8Array | string> {
      this.readFileCalls.push(path)
      return this.readFileResult
    }

    async createDir(path: string): Promise<boolean> {
      this.createDirCalls.push(path)
      return true
    }

    async deleteFile(path: string): Promise<boolean> {
      this.deleteFileCalls.push(path)
      return true
    }

    async deleteDir(path: string): Promise<boolean> {
      this.deleteDirCalls.push(path)
      return true
    }

    async unmount(path: string): Promise<boolean> {
      this.unmountCalls.push(path)
      return true
    }

    terminate(): void {
      this.terminateCalls++
    }

    emitProgress(progress: number): void {
      for (const listener of this.progressListeners) {
        listener({ progress, time: 0 })
      }
    }
  }

  const created: Array<InstanceType<typeof FakeFFmpeg>> = []
  return { FakeFFmpeg, created }
})

vi.mock("@ffmpeg/ffmpeg", () => ({
  FFmpeg: FakeFFmpeg,
  FFFSType: {
    MEMFS: "MEMFS",
    NODEFS: "NODEFS",
    NODERAWFS: "NODERAWFS",
    IDBFS: "IDBFS",
    WORKERFS: "WORKERFS",
    PROXYFS: "PROXYFS",
  },
}))

function lastInstance(): (typeof created)[number] {
  const instance = created[created.length - 1]
  if (instance === undefined) throw new Error("ninguna instancia de FFmpeg creada")
  return instance
}

beforeEach(() => {
  created.length = 0
})

describe("createFfmpegRuntime", () => {
  it("loads the core from local assets with the explicit class worker", async () => {
    const runtime = createFfmpegRuntime()

    await runtime.load()

    expect(created).toHaveLength(1)
    const loadConfig: FakeLoadConfig | undefined = lastInstance().loadCalls[0]
    expect(loadConfig).toEqual({
      classWorkerURL: "/ffmpeg/worker.js",
      coreURL: "/ffmpeg-core/ffmpeg-core.js",
      wasmURL: "/ffmpeg-core/ffmpeg-core.wasm",
    })
    expect(loadConfig?.workerURL).toBeUndefined()
  })

  it("mounts a single file with WORKERFS at the given path", async () => {
    const runtime = createFfmpegRuntime()
    const file = new File(["bytes"], "input.bin")

    await expect(runtime.mount(file, "/input")).resolves.toBe(true)

    const call: FakeMountCall | undefined = lastInstance().mountCalls[0]
    expect(call?.fsType).toBe("WORKERFS")
    expect(call?.mountPoint).toBe("/input")
    expect(call?.files).toHaveLength(1)
    expect(call?.files[0]).toBe(file)
  })

  it("reports a false mount result instead of swallowing it", async () => {
    const runtime = createFfmpegRuntime()
    await runtime.load()
    lastInstance().mountResult = false

    await expect(runtime.mount(new File(["x"], "input.bin"), "/input")).resolves.toBe(false)
  })

  it("forwards exec arguments as a fresh array and returns the exit code", async () => {
    const runtime = createFfmpegRuntime()
    const args = ["-i", "/input/input.bin", "-f", "webm", "/output/audio.webm"]

    await expect(runtime.exec(args)).resolves.toBe(0)
    expect(lastInstance().execCalls[0]).toEqual(args)
    expect(lastInstance().execCalls[0]).not.toBe(args)

    lastInstance().execResult = 1
    await expect(runtime.exec(args)).resolves.toBe(1)
  })

  it("forwards createDir, readFile, deleteFile, deleteDir and unmount with their paths", async () => {
    const runtime = createFfmpegRuntime()

    await runtime.createDir("/input")
    await expect(runtime.readFile("/output/audio.webm")).resolves.toEqual(new Uint8Array([1, 2, 3]))
    lastInstance().readFileResult = "salida en texto"
    await expect(runtime.readFile("/output/audio.webm")).resolves.toBe("salida en texto")
    await runtime.deleteFile("/output/audio.webm")
    await runtime.deleteDir("/output")
    await runtime.unmount("/input")

    const instance = lastInstance()
    expect(instance.createDirCalls).toEqual(["/input"])
    expect(instance.readFileCalls).toEqual(["/output/audio.webm", "/output/audio.webm"])
    expect(instance.deleteFileCalls).toEqual(["/output/audio.webm"])
    expect(instance.deleteDirCalls).toEqual(["/output"])
    expect(instance.unmountCalls).toEqual(["/input"])
  })

  it("forwards progress events to the registered listener", async () => {
    const runtime = createFfmpegRuntime()
    await runtime.load()

    lastInstance().emitProgress(0.25) // sin listener registrado: no debe fallar

    const values: number[] = []
    runtime.onProgress((p) => values.push(p))
    lastInstance().emitProgress(0.5)
    lastInstance().emitProgress(-0.2)

    expect(lastInstance().onEvents).toEqual(["progress"])
    expect(values).toEqual([0.5, -0.2])
  })

  it("rejects a load started after terminate without spawning a worker", async () => {
    const runtime = createFfmpegRuntime()

    runtime.terminate() // sin instancia aún: no debe lanzar

    await expect(runtime.load()).rejects.toThrow("runtime terminado antes de cargar")
    expect(created).toHaveLength(0)
  })

  it("terminate stops the underlying instance", async () => {
    const runtime = createFfmpegRuntime()
    await runtime.load()

    runtime.terminate()

    expect(lastInstance().terminateCalls).toBe(1)
  })
})
