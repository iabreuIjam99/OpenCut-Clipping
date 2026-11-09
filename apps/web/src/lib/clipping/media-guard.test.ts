import { describe, expect, it } from "vitest"
import { probeIsoBmff, probeMatroska, validateMediaFile, MediaValidationError, type MediaFileLike } from "./media-guard"

// ---- Real fixture tests ----

describe("validateMediaFile with real fixtures", () => {
  const fixturesPath = new URL("./__fixtures__/", import.meta.url).pathname

  ;["with-audio.mp4", "no-audio.mp4", "with-audio.mov", "with-audio.webm", "no-audio.webm", "with-audio.mkv"].forEach((fixture) => {
    it(`${fixture}: passes end-to-end validation`, async () => {
      const buf = await Bun.file(`${fixturesPath}${fixture}`).arrayBuffer()
      const file = new File([buf], fixture, { type: getMimeType(fixture) })
      const result = await validateMediaFile(file)
      expect(result).toBeDefined()
      expect(result.container).toMatch(/(mp4|mov|webm|mkv)/)
      expect(result.hasAudio).toBe(true)
      expect(result.durationMs).toBeLessThan(10_800_000)
    })

    it(`${fixture}: duration is reasonable (1-3s)`, async () => {
      const buf = await Bun.file(`${fixturesPath}${fixture}`).arrayBuffer()
      const file = new File([buf], fixture, { type: getMimeType(fixture) })
      const result = await validateMediaFile(file)
      expect(result.durationMs).toBeGreaterThan(1000)
      expect(result.durationMs).toBeLessThan(200000)
    })
  })
})

function getMimeType(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".") + 1)
  switch (ext) {
    case "mp4": return "video/mp4"
    case "mov": return "video/quicktime"
    case "webm": return "video/webm"
    case "mkv": return "video/mkv"
    default: return "video/mp4"
  }
}

// ---- Synthetic test helpers ----

const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))

// Minimal MP4: ftyp + moov + mdat
function createMp4({ brand = "isom", hasAudio = true }: { brand: string; hasAudio: boolean }): Uint8Array {
  // ftyp box
  const ftypSize = 16
  const ftypBox = [
    ...be32(ftypSize),
    ...ascii("ftyp"),
    ...ascii(brand.substring(0, 4)),
    ...ascii(brand.substring(4).padEnd(4, "\0").substring(0, 4)),
  ]

  // mdat box
  const mdatPayloadSize = 100
  const mdatSize = 8 + mdatPayloadSize
  const mdatBox = [
    ...be32(mdatSize),
    ...ascii("mdat"),
    ...new Array(mdatPayloadSize).fill(0x00),
  ]

  // Build
  const result: number[] = []
  result.push(...ftypBox)
  result.push(...mdatBox)

  return new Uint8Array(result)
}

// Minimal WebM
function createWebM({ docType = "webm" }: { docType: "webm" | "matroska" }): Uint8Array {
  const ebmlHeader = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x02, 0x02, 0x08, 0x08])
  const docTypeBytes = new Uint8Array(5)
  docTypeBytes[0] = 0x77 // 'w'
  docTypeBytes[1] = 0x65 // 'e'
  docTypeBytes[2] = 0x62 // 'b'
  docTypeBytes[3] = 0x6d // 'm'
  docTypeBytes[4] = 0x00 // null
  const totalLength = 13
  const result = new Uint8Array(totalLength)
  result.set(ebmlHeader, 0)
  result.set(docTypeBytes, 8)
  return result
}

// ---- Tests ----

describe("validateMediaFile with fixtures", () => {
  describe("probeIsoBmff synthetic", () => {
    it("MP4 with isom brand detects container and audio", async () => {
      const buf = createMp4({ brand: "isom", hasAudio: true })
      const file = new File([buf], "test.mp4", { type: "video/mp4" })
      const result = await probeIsoBmff(file)
      expect(result.container).toBe("mp4")
      expect(result.hasAudio).toBe(true)
      expect(result.durationMs).toBe(2000)
    })

    it("MP4 without audio: hasAudio false", async () => {
      const buf = createMp4({ brand: "isom", hasAudio: false })
      const file = new File([buf], "test.mp4", { type: "video/mp4" })
      const result = await probeIsoBmff(file)
      expect(result.container).toBe("mp4")
      expect(result.hasAudio).toBe(false)
      expect(result.durationMs).toBe(2000)
    })

    it("MP4 with qt brand (mov) detects container", async () => {
      const buf = createMp4({ brand: "qt  ", hasAudio: true })
      const file = new File([buf], "test.mov", { type: "video/quicktime" })
      const result = await probeIsoBmff(file)
      expect(result.container).toBe("mov")
      expect(result.hasAudio).toBe(true)
      expect(result.durationMs).toBe(2000)
    })
  })

  describe("probeMatroska synthetic", () => {
    it("WebM with EBML header detects webm container", async () => {
      const buf = createWebM({ docType: "webm" })
      const file = new File([buf], "test.webm", { type: "video/webm" })
      const result = await probeMatroska(file)
      expect(result.container).toBe("webm")
      expect(result.durationMs).toBe(2000)
      expect(result.hasAudio).toBe(true)
    })

    it("MKV with EBML header detects mkv container", async () => {
      const ebmlHeader = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x02, 0x02, 0x08, 0x08])
      const mkvDocType = new Uint8Array(5)
      mkvDocType[0] = 0x6d // 'm'
      mkvDocType[1] = 0x6b // 'k'
      mkvDocType[2] = 0x76 // 'v'
      mkvDocType[3] = 0x00 // null
      const totalLength = 13
      const buf = new Uint8Array(totalLength)
      buf.set(ebmlHeader, 0)
      buf.set(mkvDocType, 8)
      const file = new File([buf], "test.mkv", { type: "video/mkv" })
      const result = await probeMatroska(file)
      expect(result.container).toBe("mkv")
      expect(result.durationMs).toBe(2000)
      expect(result.hasAudio).toBe(true)
    })
  })

  describe("validateMediaFile synthetic", () => {
    it("valid MP4 with audio passes all checks", async () => {
      const buf = createMp4({ brand: "isom", hasAudio: true })
      const file = new File([buf], "test.mp4", { type: "video/mp4" })
      const result = await validateMediaFile(file)
      expect(result).toBeDefined()
      expect(result.container).toBe("mp4")
      expect(result.hasAudio).toBe(true)
      expect(result.durationMs).toBeLessThan(10_800_000)
      expect(result.durationMs).toBeGreaterThan(0)
    })

    it("MP4 without audio rejects with NO_AUDIO_TRACK", async () => {
      const buf = createMp4({ brand: "isom", hasAudio: false })
      const file = new File([buf], "test.mp4", { type: "video/mp4" })
      await expect(validateMediaFile(file)).rejects.toThrow(MediaValidationError)
      try {
        await validateMediaFile(file)
      } catch (e) {
        expect(e).toBeInstanceOf(MediaValidationError)
        expect((e as MediaValidationError).code).toBe("NO_AUDIO_TRACK")
      }
    })

    it("duration exceeded throws DURATION_EXCEEDED", async () => {
      const file = new File([new Uint8Array(1)], "test.mp4", { type: "video/mp4" })
      ;(file as any).size = 1
      Object.defineProperty(file, "size", {
        value: 1,
        writable: true,
        configurable: true,
      })
      await expect(validateMediaFile(file)).rejects.toThrow(MediaValidationError)
      try {
        await validateMediaFile(file)
      } catch (e) {
        expect(e).toBeInstanceOf(MediaValidationError)
        expect((e as MediaValidationError).code).toBe("DURATION_EXCEEDED")
      }
    })

    it("file over 4 GiB rejects with FILE_TOO_LARGE", async () => {
      const largeFile: MediaFileLike = {
        size: 5 * 1024 * 1024 * 1024 + 1,
        slice: (_start?: number, _end?: number) => new Blob(),
      }
      await expect(validateMediaFile(largeFile)).rejects.toThrow(MediaValidationError)
    })

    it("unknown container (PNG magic bytes) rejects", async () => {
      const buf = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
      const file = new File([buf], "test.png", { type: "image/png" })
      await expect(validateMediaFile(file)).rejects.toThrow(MediaValidationError)
    })

    it("mobile device rejected first", async () => {
      const buf = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
      const file = new File([buf], "test.mp4", { type: "video/mp4" })
      await expect(validateMediaFile(file, { isMobile: true })).rejects.toThrow(MediaValidationError)
    })
  })
})