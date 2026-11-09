/**
 * Thin, injectable adapter over `@ffmpeg/ffmpeg` (ffmpeg.wasm).
 *
 * This is the ONLY module that loads `@ffmpeg/ffmpeg`, and it does so through a
 * dynamic `import()` inside {@link createFfmpegRuntime}; the orchestration in
 * `extract-audio.ts` never touches the package (jsdom cannot run the WASM, so
 * tests inject a fake runtime instead).
 *
 * The video is mounted with `FFFSType.WORKERFS` and never copied into the
 * WASM heap: copying a multi-gigabyte file there is the OOM trap the Task 6
 * spike avoided.
 *
 * @module ffmpeg-runtime
 */

import type { FFMessageLoadConfig, FFmpeg } from "@ffmpeg/ffmpeg"

/** Value type of the `FFFSType` enum, resolved without a runtime import. */
type FfsTypeValue = typeof import("@ffmpeg/ffmpeg")["FFFSType"]

/** Surface `extract-audio.ts` needs; `createFfmpegRuntime` implements it. */
export interface AudioExtractionRuntime {
  load(): Promise<void>
  createDir(path: string): Promise<void>
  mount(file: File, path: string): Promise<boolean>
  exec(args: readonly string[]): Promise<number>
  readFile(path: string): Promise<Uint8Array | string>
  deleteFile(path: string): Promise<void>
  deleteDir(path: string): Promise<void>
  unmount(path: string): Promise<void>
  terminate(): void
  onProgress(cb: (p: number) => void): void
}

/**
 * Assets served locally by the Vite copy plugin (never a CDN):
 * `public/ffmpeg-core/*` and `public/ffmpeg/worker.js` (R2).
 */
const CORE_CONFIG: FFMessageLoadConfig = {
  classWorkerURL: "/ffmpeg/worker.js",
  coreURL: "/ffmpeg-core/ffmpeg-core.js",
  wasmURL: "/ffmpeg-core/ffmpeg-core.wasm",
}

interface PreparedRuntime {
  readonly created: FFmpeg
  readonly fsType: FfsTypeValue
}

/**
 * Creates a fresh runtime backed by a new `FFmpeg` instance (no singletons:
 * every extraction reloads the core, 56-74 ms measured in the Task 6 spike).
 */
export function createFfmpegRuntime(): AudioExtractionRuntime {
  let ffmpeg: FFmpeg | null = null
  let prepared: Promise<PreparedRuntime> | null = null
  let terminated = false
  let progressHandler: ((progress: number) => void) | null = null

  function ready(): Promise<PreparedRuntime> {
    prepared ??= import("@ffmpeg/ffmpeg").then((mod) => {
      // `terminate()` raced with the dynamic import: never spawn a worker that
      // nothing will ever terminate.
      if (terminated) throw new Error("runtime terminado antes de cargar")
      const created = new mod.FFmpeg()
      created.on("progress", (event) => progressHandler?.(event.progress))
      ffmpeg = created
      return { created, fsType: mod.FFFSType }
    })
    return prepared
  }

  return {
    async load(): Promise<void> {
      const { created } = await ready()
      await created.load(CORE_CONFIG)
    },

    async createDir(path: string): Promise<void> {
      const { created } = await ready()
      await created.createDir(path)
    },

    async mount(file: File, path: string): Promise<boolean> {
      const { created, fsType } = await ready()
      return created.mount(fsType.WORKERFS, { files: [file] }, path)
    },

    async exec(args: readonly string[]): Promise<number> {
      const { created } = await ready()
      return created.exec([...args])
    },

    async readFile(path: string): Promise<Uint8Array | string> {
      const { created } = await ready()
      return created.readFile(path)
    },

    async deleteFile(path: string): Promise<void> {
      const { created } = await ready()
      await created.deleteFile(path)
    },

    async deleteDir(path: string): Promise<void> {
      const { created } = await ready()
      await created.deleteDir(path)
    },

    async unmount(path: string): Promise<void> {
      const { created } = await ready()
      await created.unmount(path)
    },

    terminate(): void {
      terminated = true
      ffmpeg?.terminate()
    },

    onProgress(cb: (p: number) => void): void {
      progressHandler = cb
    },
  }
}
