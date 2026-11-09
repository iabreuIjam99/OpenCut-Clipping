import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  type MediaFileLike,
  MediaValidationError,
  probeIsoBmff,
  probeMatroska,
  validateMediaFile,
} from "./media-guard"

/**
 * Fixtures were generated once with ffmpeg-static (from `spikes/workerfs`), 2 s,
 * 160x120, 5 fps:
 *
 *   ffmpeg -f lavfi -i color=c=black:s=160x120:r=5 -f lavfi -i sine=frequency=440 \
 *     -t 2 -c:v libx264 -pix_fmt yuv420p -c:a aac -ac 1 -b:a 32k -movflags +faststart \
 *     apps/web/src/lib/clipping/__fixtures__/with-audio.mp4
 *
 * `no-audio.*` used `-an`; `.webm` used libvpx/opus; `.mkv` is a remux of the webm.
 * They are committed because they are the only way to assert `NO_AUDIO_TRACK`
 * against a real container.
 */

// ---------------------------------------------------------------------------
// Byte builders
// ---------------------------------------------------------------------------

const be32 = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
]

const be64 = (n: number): number[] => [...be32(Math.floor(n / 0x1_00_00_00_00)), ...be32(n >>> 0)]

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0) & 0xff)

const bytes = (...parts: number[][]): number[] => parts.flat()

const box = (type: string, payload: number[]): number[] =>
  bytes(be32(8 + payload.length), ascii(type), payload)

const largeBox = (type: string, payload: number[]): number[] =>
  bytes(be32(1), ascii(type), be64(16 + payload.length), payload)

const sizeToEofBox = (type: string, payload: number[]): number[] =>
  bytes(be32(0), ascii(type), payload)

const fullBox = (type: string, version: number, flags: number, payload: number[]): number[] =>
  box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff, ...payload])

const ftyp = (brand: string): number[] => box("ftyp", bytes(ascii(brand), be32(0), ascii("isom")))

const mvhd = (timescale: number, duration: number, version: 0 | 1 = 0): number[] => {
  if (version === 1) {
    return fullBox(
      "mvhd",
      1,
      0,
      bytes(be64(0), be64(0), be32(timescale), be64(duration), be32(0x0001_0000), be32(0)),
    )
  }
  return fullBox(
    "mvhd",
    0,
    0,
    bytes(be32(0), be32(0), be32(timescale), be32(duration), be32(0x0001_0000), be32(0)),
  )
}

const hdlr = (handler: string): number[] =>
  fullBox("hdlr", 0, 0, bytes(be32(0), ascii(handler), be32(0), be32(0), be32(0)))

const trak = (handler: string): number[] =>
  box("trak", bytes(box("tkhd", []), box("mdia", bytes(box("mdhd", []), hdlr(handler)))))

interface Mp4Options {
  brand?: string
  timescale?: number
  durationUnits?: number
  audio?: boolean
  version?: 0 | 1
  /** Boxes prepended after `ftyp` (e.g. a large `mdat`). */
  between?: number[]
  moovOverride?: number[]
}

function mp4(options: Mp4Options = {}): Uint8Array {
  const {
    brand = "isom",
    timescale = 1000,
    durationUnits = 2000,
    audio = true,
    version = 0,
    between = [],
    moovOverride,
  } = options

  const moov =
    moovOverride ??
    box("moov", bytes(mvhd(timescale, durationUnits, version), ...(audio ? [trak("soun")] : [])))

  return new Uint8Array(bytes(ftyp(brand), between, moov))
}

/** Encodes an EBML size vint. Values are kept below the all-ones "unknown" marker. */
function vint(value: number): number[] {
  let length = 1
  while (length < 8 && value > 2 ** (7 * length) - 2) length++

  const out: number[] = new Array<number>(length).fill(0)
  let rest = value
  for (let i = length - 1; i >= 0; i--) {
    out[i] = rest % 256
    rest = Math.floor(rest / 256)
  }
  out[0] |= 1 << (8 - length)
  return out
}

const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]

const ebml = (id: number[], payload: number[], unknownSize = false): number[] =>
  bytes(id, unknownSize ? UNKNOWN_SIZE : vint(payload.length), payload)

const f64 = (n: number): number[] => {
  const buffer = new ArrayBuffer(8)
  new DataView(buffer).setFloat64(0, n, false)
  return [...new Uint8Array(buffer)]
}

const EBML_HEADER = [0x1a, 0x45, 0xdf, 0xa3]
const EBML_DOC_TYPE = [0x42, 0x82]
const EBML_SEGMENT = [0x18, 0x53, 0x80, 0x67]
const EBML_INFO = [0x15, 0x49, 0xa9, 0x66]
const EBML_TRACKS = [0x16, 0x54, 0xae, 0x6b]
const EBML_TRACK_ENTRY = [0xae]
const EBML_TRACK_TYPE = [0x83]
const EBML_TIMECODE_SCALE = [0x2a, 0xd7, 0xb1]
const EBML_DURATION = [0x44, 0x89]
const EBML_CLUSTER = [0x1f, 0x43, 0xb6, 0x75]

function ebmlHeader(docType: string | null): number[] {
  return ebml(
    EBML_HEADER,
    bytes(
      ebml([0x42, 0x86], [1]),
      ebml([0x42, 0xf7], [1]),
      ebml([0x42, 0xf2], [4]),
      ebml([0x42, 0xf3], [8]),
      ...(docType === null ? [] : [ebml(EBML_DOC_TYPE, ascii(docType))]),
      ebml([0x42, 0x87], [4]),
      ebml([0x42, 0x85], [2]),
    ),
  )
}

interface MatroskaOptions {
  docType?: string
  timecodeScale?: number
  duration?: number
  audio?: boolean
  trackType?: number
  unknownSegmentSize?: boolean
  unknownInfoSize?: boolean
  /** Raw segment children override. */
  segmentChildren?: number[]
}

function matroska(options: MatroskaOptions = {}): Uint8Array {
  const {
    docType = "webm",
    timecodeScale = 1_000_000,
    duration = 2000,
    audio = true,
    trackType = 2,
    unknownSegmentSize = false,
    unknownInfoSize = false,
    segmentChildren,
  } = options

  const info = ebml(
    EBML_INFO,
    bytes(ebml(EBML_TIMECODE_SCALE, be32(timecodeScale)), ebml(EBML_DURATION, f64(duration))),
    unknownInfoSize,
  )
  const tracks = ebml(
    EBML_TRACKS,
    bytes(ebml(EBML_TRACK_ENTRY, bytes(ebml(EBML_TRACK_TYPE, [trackType])))),
  )
  const cluster = ebml(EBML_CLUSTER, [0x00])

  const children = segmentChildren ?? (audio ? bytes(info, tracks, cluster) : bytes(info, cluster))

  return new Uint8Array(
    bytes(ebmlHeader(docType), ebml(EBML_SEGMENT, children, unknownSegmentSize)),
  )
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(resolve(process.cwd(), "src/lib/clipping/__fixtures__", name)))

/** `MediaFileLike` that copies the slice, so it does not alias the source buffer. */
function makeFile(data: Uint8Array, type = "video/mp4", name = "clip.mp4"): File {
  return new File([new Uint8Array(data)], name, { type })
}

/** A huge logical file whose real bytes only exist at the start. */
class SparseFile implements MediaFileLike {
  sliced = 0

  constructor(
    readonly size: number,
    private readonly head: Uint8Array,
  ) {}

  slice(start = 0, end = this.size): Blob {
    const from = Math.max(0, start)
    const to = Math.min(end, this.size, this.head.length)
    const part = from < to ? this.head.slice(from, to) : new Uint8Array(0)
    this.sliced += part.length
    return new Blob([part])
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// ISO-BMFF
// ---------------------------------------------------------------------------

describe("probeIsoBmff", () => {
  it("reads duration and audio track from a well-formed MP4", async () => {
    const result = await probeIsoBmff(makeFile(mp4()))

    expect(result).toEqual({ container: "mp4", durationMs: 2000, hasAudio: true })
  })

  it("returns mov for the qt brand and mp4 for the isom brand", async () => {
    await expect(probeIsoBmff(makeFile(mp4({ brand: "qt  " })))).resolves.toMatchObject({
      container: "mov",
    })
    await expect(probeIsoBmff(makeFile(mp4({ brand: "iso2" })))).resolves.toMatchObject({
      container: "mp4",
    })
  })

  it("returns unknown for an unrecognised brand", async () => {
    const result = await probeIsoBmff(makeFile(mp4({ brand: "zzzz" })))

    expect(result.container).toBe("unknown")
  })

  it("returns unknown when ftyp has no brand payload", async () => {
    const file = makeFile(new Uint8Array(box("ftyp", [])))

    await expect(probeIsoBmff(file)).resolves.toEqual({
      container: "unknown",
      durationMs: 0,
      hasAudio: false,
    })
  })

  it("parses a version 1 mvhd (64-bit duration)", async () => {
    const result = await probeIsoBmff(
      makeFile(mp4({ timescale: 90_000, durationUnits: 180_000, version: 1 })),
    )

    expect(result.container).toBe("mp4")
    expect(result.durationMs).toBeCloseTo(2000, 6)
  })

  it("finds moov after a large mdat without reading the video payload", async () => {
    const mdat = box("mdat", new Array<number>(100_000).fill(0))
    const file = makeFile(mp4({ between: mdat }))

    const result = await probeIsoBmff(file)

    expect(result).toEqual({ container: "mp4", durationMs: 2000, hasAudio: true })
  })

  it("supports a 64-bit largesize box header", async () => {
    const moov = largeBox("moov", bytes(mvhd(1000, 2000), trak("soun")))
    const file = makeFile(mp4({ moovOverride: moov }))

    await expect(probeIsoBmff(file)).resolves.toMatchObject({
      container: "mp4",
      durationMs: 2000,
      hasAudio: true,
    })
  })

  it("supports a size == 0 box that runs to end of file", async () => {
    const moov = sizeToEofBox("moov", bytes(mvhd(1000, 2000), trak("soun")))
    const file = makeFile(new Uint8Array(bytes(ftyp("isom"), moov)))

    await expect(probeIsoBmff(file)).resolves.toMatchObject({
      container: "mp4",
      durationMs: 2000,
      hasAudio: true,
    })
  })

  it("returns unknown when the file ends with a partial box header", async () => {
    const file = makeFile(new Uint8Array(bytes(ftyp("isom"), [0, 0, 0, 0])))

    await expect(probeIsoBmff(file)).resolves.toMatchObject({ container: "unknown" })
  })

  it("rejects a 64-bit box whose largesize field is truncated", async () => {
    const file = makeFile(new Uint8Array(bytes(ftyp("isom"), be32(1), ascii("moov"))))

    await expect(probeIsoBmff(file)).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" })
  })

  it("rejects a box smaller than its own header", async () => {
    const file = makeFile(new Uint8Array(bytes(ftyp("isom"), be32(4), ascii("free"))))

    await expect(probeIsoBmff(file)).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" })
  })

  it("returns unknown when moov carries no mvhd", async () => {
    const file = makeFile(mp4({ moovOverride: box("moov", bytes(trak("soun"))) }))

    await expect(probeIsoBmff(file)).resolves.toMatchObject({ container: "unknown" })
  })

  it("returns unknown when mvhd is truncated", async () => {
    const truncated = fullBox("mvhd", 0, 0, [0, 0, 0, 0])
    const file = makeFile(mp4({ moovOverride: box("moov", bytes(truncated, trak("soun"))) }))

    await expect(probeIsoBmff(file)).resolves.toMatchObject({ container: "unknown" })
  })

  it("returns unknown when mvhd timescale is zero", async () => {
    const file = makeFile(mp4({ timescale: 0 }))

    await expect(probeIsoBmff(file)).resolves.toMatchObject({ container: "unknown" })
  })

  it("reports no audio when trak has no mdia, no hdlr, or a video handler", async () => {
    const noMdia = box("trak", bytes(box("tkhd", [])))
    const noHdlr = box("trak", bytes(box("mdia", bytes(box("mdhd", [])))))
    const video = trak("vide")
    const shortHdlr = box("trak", bytes(box("mdia", bytes(box("hdlr", bytes(be32(0), be32(0)))))))

    for (const trakBox of [noMdia, noHdlr, video, shortHdlr]) {
      const file = makeFile(
        mp4({
          audio: false,
          moovOverride: box("moov", bytes(mvhd(1000, 2000), trakBox)),
        }),
      )
      await expect(probeIsoBmff(file)).resolves.toMatchObject({
        container: "mp4",
        durationMs: 2000,
        hasAudio: false,
      })
    }
  })

  it("stops after the iteration budget without hanging", async () => {
    const filler = new Array<number>(10_001).fill(0).flatMap(() => box("free", []))
    const file = makeFile(new Uint8Array(bytes(ftyp("isom"), filler, box("moov", mvhd(1, 1)))))

    await expect(probeIsoBmff(file)).resolves.toMatchObject({ container: "unknown" })
  })
})

// ---------------------------------------------------------------------------
// Matroska
// ---------------------------------------------------------------------------

describe("probeMatroska", () => {
  it("reads duration and audio track from WebM and MKV", async () => {
    await expect(probeMatroska(makeFile(matroska({ docType: "webm" })))).resolves.toEqual({
      container: "webm",
      durationMs: 2000,
      hasAudio: true,
    })
    await expect(probeMatroska(makeFile(matroska({ docType: "matroska" })))).resolves.toMatchObject(
      { container: "mkv" },
    )
  })

  it("returns unknown for an unknown DocType", async () => {
    const result = await probeMatroska(makeFile(matroska({ docType: "ogg" })))

    expect(result.container).toBe("unknown")
  })

  it("returns unknown when the EBML header has no DocType", async () => {
    const header = ebml(EBML_HEADER, bytes(ebml([0x42, 0x86], [1])))
    const file = makeFile(new Uint8Array(bytes(header, ebml(EBML_SEGMENT, []))))

    await expect(probeMatroska(file)).resolves.toMatchObject({ container: "unknown" })
  })

  it("returns unknown when the EBML header payload is empty", async () => {
    const file = makeFile(new Uint8Array(bytes(EBML_HEADER, [0x80])))

    await expect(probeMatroska(file)).resolves.toMatchObject({ container: "unknown" })
  })

  it("returns unknown when the first element is not an EBML header", async () => {
    await expect(probeMatroska(makeFile(mp4()))).resolves.toMatchObject({ container: "unknown" })
    const segmentFirst = makeFile(new Uint8Array(bytes(ebml(EBML_SEGMENT, []))))
    await expect(probeMatroska(segmentFirst)).resolves.toMatchObject({ container: "unknown" })
  })

  it("returns unknown when the EBML header is truncated", async () => {
    const file = makeFile(new Uint8Array(bytes(EBML_HEADER, [0, 0, 0, 0])))

    await expect(probeMatroska(file)).resolves.toMatchObject({ container: "unknown" })
  })

  it("returns unknown when there is no Segment element", async () => {
    const voidElement = ebml([0xec], [0])
    const file = makeFile(new Uint8Array(bytes(ebmlHeader("webm"), voidElement)))

    await expect(probeMatroska(file)).resolves.toMatchObject({ container: "unknown" })
  })

  it("returns unknown when the trailing bytes after the header are not an element", async () => {
    const file = makeFile(new Uint8Array(bytes(ebmlHeader("webm"), [0, 0, 0, 0])))

    await expect(probeMatroska(file)).resolves.toMatchObject({ container: "unknown" })
  })

  it("supports a Segment with unknown size", async () => {
    const file = makeFile(matroska({ unknownSegmentSize: true }))

    await expect(probeMatroska(file)).resolves.toMatchObject({
      container: "webm",
      durationMs: 2000,
      hasAudio: true,
    })
  })

  it("defaults TimecodeScale to 1 000 000 when absent or zero", async () => {
    const absence = new Uint8Array(
      bytes(
        ebmlHeader("webm"),
        ebml(
          EBML_SEGMENT,
          bytes(
            ebml(EBML_INFO, ebml(EBML_DURATION, f64(2000))),
            ebml(EBML_TRACKS, ebml(EBML_TRACK_ENTRY, ebml(EBML_TRACK_TYPE, [2]))),
            ebml(EBML_CLUSTER, [0]),
          ),
        ),
      ),
    )
    await expect(probeMatroska(makeFile(absence))).resolves.toMatchObject({ durationMs: 2000 })

    const zero = new Uint8Array(
      bytes(
        ebmlHeader("webm"),
        ebml(
          EBML_SEGMENT,
          bytes(
            ebml(EBML_INFO, bytes(ebml(EBML_TIMECODE_SCALE, [0]), ebml(EBML_DURATION, f64(2000)))),
            ebml(EBML_TRACKS, ebml(EBML_TRACK_ENTRY, ebml(EBML_TRACK_TYPE, [2]))),
            ebml(EBML_CLUSTER, [0]),
          ),
        ),
      ),
    )
    await expect(probeMatroska(makeFile(zero))).resolves.toMatchObject({ durationMs: 2000 })
  })

  it("returns unknown when Duration is absent, zero, malformed or the Info is empty", async () => {
    const noDuration = new Uint8Array(
      bytes(
        ebmlHeader("webm"),
        ebml(
          EBML_SEGMENT,
          bytes(
            ebml(EBML_INFO, ebml(EBML_TIMECODE_SCALE, be32(1_000_000))),
            ebml(EBML_TRACKS, ebml(EBML_TRACK_ENTRY, ebml(EBML_TRACK_TYPE, [2]))),
            ebml(EBML_CLUSTER, [0]),
          ),
        ),
      ),
    )
    const zeroDuration = new Uint8Array(
      bytes(
        ebmlHeader("webm"),
        ebml(EBML_SEGMENT, bytes(ebml(EBML_INFO, ebml(EBML_DURATION, f64(0))))),
      ),
    )
    const shortDuration = new Uint8Array(
      bytes(
        ebmlHeader("webm"),
        ebml(EBML_SEGMENT, bytes(ebml(EBML_INFO, ebml(EBML_DURATION, [0, 1])))),
      ),
    )
    const emptyInfo = new Uint8Array(
      bytes(ebmlHeader("webm"), ebml(EBML_SEGMENT, ebml(EBML_INFO, []))),
    )

    await expect(probeMatroska(makeFile(noDuration))).resolves.toMatchObject({
      container: "unknown",
    })
    await expect(probeMatroska(makeFile(zeroDuration))).resolves.toMatchObject({
      container: "unknown",
    })
    await expect(probeMatroska(makeFile(shortDuration))).resolves.toMatchObject({
      container: "unknown",
    })
    await expect(probeMatroska(makeFile(emptyInfo))).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA",
    })
  })

  it("rejects an Info element larger than the parser cap", async () => {
    const bigInfo = ebml(EBML_SEGMENT, ebml(EBML_INFO, new Array<number>(70_000).fill(0)))
    const file = makeFile(new Uint8Array(bytes(ebmlHeader("webm"), bigInfo)))

    await expect(probeMatroska(file)).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" })
  })

  it("reports no audio for video tracks, missing TrackType or unknown-size entries", async () => {
    const video = makeFile(matroska({ trackType: 1 }))
    await expect(probeMatroska(video)).resolves.toMatchObject({ durationMs: 2000, hasAudio: false })

    const noType = makeFile(
      new Uint8Array(
        bytes(
          ebmlHeader("webm"),
          ebml(
            EBML_SEGMENT,
            bytes(
              ebml(EBML_INFO, ebml(EBML_DURATION, f64(2000))),
              ebml(EBML_TRACKS, ebml(EBML_TRACK_ENTRY, ebml([0xb3], [0]))),
              ebml(EBML_CLUSTER, [0]),
            ),
          ),
        ),
      ),
    )
    await expect(probeMatroska(noType)).resolves.toMatchObject({ hasAudio: false })

    const unknownEntry = makeFile(
      new Uint8Array(
        bytes(
          ebmlHeader("webm"),
          ebml(
            EBML_SEGMENT,
            bytes(
              ebml(EBML_INFO, ebml(EBML_DURATION, f64(2000))),
              ebml(EBML_TRACKS, ebml(EBML_TRACK_ENTRY, ebml(EBML_TRACK_TYPE, [2]), true)),
              ebml(EBML_CLUSTER, [0]),
            ),
          ),
        ),
      ),
    )
    await expect(probeMatroska(unknownEntry)).resolves.toMatchObject({ hasAudio: false })
  })

  it("stops at the first Cluster without reading it", async () => {
    const file = makeFile(
      new Uint8Array(
        bytes(
          ebmlHeader("webm"),
          ebml(
            EBML_SEGMENT,
            bytes(
              ebml(EBML_INFO, ebml(EBML_DURATION, f64(2000))),
              ebml(EBML_CLUSTER, new Array<number>(50_000).fill(0)),
              ebml(EBML_TRACKS, ebml(EBML_TRACK_ENTRY, ebml(EBML_TRACK_TYPE, [2]))),
            ),
          ),
        ),
      ),
    )

    await expect(probeMatroska(file)).resolves.toMatchObject({ hasAudio: false })
  })

  it("returns unknown when an unknown-size child aborts the segment walk", async () => {
    const file = makeFile(
      new Uint8Array(
        bytes(
          ebmlHeader("webm"),
          ebml(EBML_SEGMENT, ebml(EBML_INFO, ebml(EBML_DURATION, f64(2000)), true)),
        ),
      ),
    )

    await expect(probeMatroska(file)).resolves.toMatchObject({ container: "unknown" })
  })

  it("returns unknown when a segment child header is not an element", async () => {
    const file = makeFile(
      new Uint8Array(bytes(ebmlHeader("webm"), ebml(EBML_SEGMENT, [0x00, 0x00, 0x00]))),
    )

    await expect(probeMatroska(file)).resolves.toMatchObject({ container: "unknown" })
  })
})

// ---------------------------------------------------------------------------
// validateMediaFile — Gherkin scenarios (apps/web/features/ingesta.feature)
// ---------------------------------------------------------------------------

describe("validateMediaFile", () => {
  it("Scenario: Aceptar un MP4 con audio dentro de los limites", async () => {
    const result = await validateMediaFile(makeFile(mp4()))

    expect(result).toEqual({ container: "mp4", durationMs: 2000, hasAudio: true })
  })

  it("Scenario: Rechazar un fichero con MIME de video pero bytes de texto", async () => {
    const text = makeFile(new Uint8Array(ascii("esto no es un video, es texto plano")), "video/mp4")

    await expect(validateMediaFile(text)).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" })
    await expect(validateMediaFile(text)).rejects.toBeInstanceOf(MediaValidationError)
  })

  it("accepts valid bytes regardless of the declared MIME type", async () => {
    const disguised = makeFile(mp4(), "text/plain", "notas.txt")

    await expect(validateMediaFile(disguised)).resolves.toMatchObject({ container: "mp4" })
  })

  it("Scenario: Rechazar por tamano mayor de 4 GiB sin leer el fichero", async () => {
    const huge = new SparseFile(4 * 1024 ** 3 + 1, new Uint8Array(0))

    await expect(validateMediaFile(huge)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" })
    expect(huge.sliced).toBe(0)
  })

  it("honours an injected maxBytes without reading the file", async () => {
    const file = new SparseFile(20, new Uint8Array(20))

    await expect(validateMediaFile(file, { maxBytes: 10 })).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    })
    expect(file.sliced).toBe(0)
  })

  it("Scenario: Rechazar por duracion mayor de 3 horas", async () => {
    const iso = makeFile(mp4({ timescale: 1000, durationUnits: 10_800_001 }))
    await expect(validateMediaFile(iso)).rejects.toMatchObject({ code: "DURATION_EXCEEDED" })

    const mkv = makeFile(matroska({ docType: "matroska", duration: 10_800_001 }))
    await expect(validateMediaFile(mkv)).rejects.toMatchObject({ code: "DURATION_EXCEEDED" })
  })

  it("honours an injected maxDurationMs", async () => {
    await expect(validateMediaFile(makeFile(mp4()), { maxDurationMs: 1000 })).rejects.toMatchObject(
      { code: "DURATION_EXCEEDED" },
    )
  })

  it("Scenario: Rechazar un MP4 sin pista de audio", async () => {
    await expect(validateMediaFile(makeFile(fixture("no-audio.mp4")))).rejects.toMatchObject({
      code: "NO_AUDIO_TRACK",
    })
  })

  it("Scenario: Rechazar un WebM sin pista de audio", async () => {
    await expect(validateMediaFile(makeFile(fixture("no-audio.webm")))).rejects.toMatchObject({
      code: "NO_AUDIO_TRACK",
    })
  })

  it("Scenario: Rechazar en movil aunque el fichero sea valido", async () => {
    await expect(validateMediaFile(makeFile(mp4()), { isMobile: true })).rejects.toMatchObject({
      code: "UNSUPPORTED_DEVICE",
    })
  })

  it("detects a mobile device from navigator.userAgentData", async () => {
    vi.stubGlobal("navigator", { userAgent: "desktop", userAgentData: { mobile: true } })

    await expect(validateMediaFile(makeFile(mp4()))).rejects.toMatchObject({
      code: "UNSUPPORTED_DEVICE",
    })
  })

  it("detects a mobile device from navigator.userAgent", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    })

    await expect(validateMediaFile(makeFile(mp4()))).rejects.toMatchObject({
      code: "UNSUPPORTED_DEVICE",
    })
  })

  it("accepts a desktop userAgent", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    })

    await expect(validateMediaFile(makeFile(mp4()))).resolves.toMatchObject({ container: "mp4" })
  })

  it("Scenario: Aceptar un MOV y distinguirlo de un MP4", async () => {
    const mov = await validateMediaFile(makeFile(mp4({ brand: "qt  " }), "video/quicktime"))
    const mp4Result = await validateMediaFile(makeFile(mp4({ brand: "mp42" })))

    expect(mov.container).toBe("mov")
    expect(mp4Result.container).toBe("mp4")
  })

  it("Scenario: Rechazar un contenedor corrupto con magic bytes validos", async () => {
    const unknownBrand = makeFile(mp4({ brand: "zzzz" }))
    await expect(validateMediaFile(unknownBrand)).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA",
    })

    const brokenSegment = makeFile(new Uint8Array(bytes(ebmlHeader("webm"), EBML_SEGMENT, [0x80])))
    await expect(validateMediaFile(brokenSegment)).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA",
    })
  })

  it("rejects files smaller than a box header", async () => {
    await expect(validateMediaFile(makeFile(new Uint8Array(4)))).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA",
    })
  })

  it("never reads more than the read budget", async () => {
    const file = new SparseFile(200_000_000, mp4())

    await expect(validateMediaFile(file, { maxReadBytes: 64 })).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA",
    })
    expect(file.sliced).toBeLessThanOrEqual(12 + 64)
  })

  it("accepts a 4 GiB file when moov is near the start, reading only headers", async () => {
    const file = new SparseFile(4 * 1024 ** 3, mp4())

    await expect(validateMediaFile(file)).resolves.toMatchObject({
      container: "mp4",
      durationMs: 2000,
      hasAudio: true,
    })
    expect(file.sliced).toBeLessThan(1024)
  })

  it("uses the real fixtures end to end", async () => {
    const cases: Array<[string, "mp4" | "mov" | "webm" | "mkv"]> = [
      ["with-audio.mp4", "mp4"],
      ["with-audio.mov", "mov"],
      ["with-audio.webm", "webm"],
      ["with-audio.mkv", "mkv"],
    ]

    for (const [name, container] of cases) {
      const result = await validateMediaFile(makeFile(fixture(name)))
      expect(result.container).toBe(container)
      expect(result.hasAudio).toBe(true)
      expect(result.durationMs).toBeGreaterThanOrEqual(1900)
      expect(result.durationMs).toBeLessThanOrEqual(2200)
    }
  })

  it("applies the documented check order", async () => {
    const huge = new SparseFile(4 * 1024 ** 3 + 1, new Uint8Array(0))
    await expect(validateMediaFile(huge, { isMobile: true })).rejects.toMatchObject({
      code: "UNSUPPORTED_DEVICE",
    })
    expect(huge.sliced).toBe(0)

    const text = new SparseFile(20, new Uint8Array(ascii("esto no es un video")))
    await expect(validateMediaFile(text, { maxBytes: 10 })).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    })
    expect(text.sliced).toBe(0)

    const unknownBrandButLong = makeFile(mp4({ brand: "zzzz", durationUnits: 10_800_001 }))
    await expect(validateMediaFile(unknownBrandButLong)).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA",
    })

    const longAndSilent = makeFile(mp4({ durationUnits: 10_800_001, audio: false }))
    await expect(validateMediaFile(longAndSilent)).rejects.toMatchObject({
      code: "DURATION_EXCEEDED",
    })
  })

  it("logs the technical detail to console.error in development only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await expect(validateMediaFile(makeFile(mp4({ brand: "zzzz" })))).rejects.toMatchObject({
        code: "UNSUPPORTED_MEDIA",
      })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0]?.[0]).toBe("[media-guard] validacion fallida")
      expect(spy.mock.calls[0]?.[1]).toBeInstanceOf(MediaValidationError)
    } finally {
      spy.mockRestore()
    }
  })

  it("produces generic Spanish messages without technical detail", () => {
    const error = new MediaValidationError("FILE_TOO_LARGE")

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("MediaValidationError")
    expect(error.code).toBe("FILE_TOO_LARGE")
    expect(error.message).toBe("El archivo supera el tamaño máximo permitido.")
    expect(error.message).not.toMatch(/bytes|MB|GB|slice|offset/i)
  })
})
