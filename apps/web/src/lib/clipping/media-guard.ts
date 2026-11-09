/**
 * Media guard: validates an uploaded file by content before any processing.
 *
 * Two containers are supported: ISO-BMFF (MP4/MOV) and Matroska (WebM/MKV).
 * Every read goes through {@link SliceReader}, which slices the file and enforces
 * a byte budget, so a 4 GiB upload never materialises in memory.
 *
 * Check order: device → size → container → duration → audio track.
 *
 * @module media-guard
 */

export type MediaContainer = "mp4" | "mov" | "webm" | "mkv" | "unknown"

export type MediaValidationCode =
  | "UNSUPPORTED_MEDIA"
  | "FILE_TOO_LARGE"
  | "DURATION_EXCEEDED"
  | "NO_AUDIO_TRACK"
  | "UNSUPPORTED_DEVICE"

export type MediaInfo = {
  readonly container: MediaContainer
  readonly durationMs: number
  readonly hasAudio: boolean
}

export type ProbeResult = MediaInfo

const ERROR_MESSAGES: Record<MediaValidationCode, string> = {
  UNSUPPORTED_MEDIA: "El archivo no es un vídeo compatible.",
  FILE_TOO_LARGE: "El archivo supera el tamaño máximo permitido.",
  DURATION_EXCEEDED: "El vídeo supera la duración máxima permitida.",
  NO_AUDIO_TRACK: "El vídeo no tiene pista de audio.",
  UNSUPPORTED_DEVICE: "Esta función solo está disponible en ordenador.",
}

/** Error thrown by {@link validateMediaFile}; the message is always generic. */
export class MediaValidationError extends Error {
  readonly code: MediaValidationCode

  constructor(code: MediaValidationCode, options?: ErrorOptions) {
    super(ERROR_MESSAGES[code], options)
    this.name = "MediaValidationError"
    this.code = code
  }
}

/** Minimal surface the guard needs; `File` satisfies it structurally. */
export interface MediaFileLike {
  readonly size: number
  slice(start?: number, end?: number): Blob
}

export interface ValidateOptions {
  isMobile?: boolean
  maxBytes?: number
  maxDurationMs?: number
  /** Test-only override of the read budget. */
  maxReadBytes?: number
}

export interface ProbeOptions {
  /** Test-only override of the read budget. */
  maxReadBytes?: number
}

const MAX_READ_BYTES = 8 * 1024 * 1024
const MAX_ITERATIONS = 10_000
const DEFAULT_MAX_BYTES = 4 * 1024 ** 3
const DEFAULT_MAX_DURATION_MS = 10_800_000
const MAX_EBML_HEADER_BYTES = 4 * 1024
const MAX_INFO_BYTES = 64 * 1024
const MAX_TRACKS_BYTES = 4 * 1024 * 1024

/**
 * Sequential reader over `MediaFileLike` with a global byte budget.
 * Reads are always bounded: a single call cannot exceed `budgetBytes`.
 */
class SliceReader {
  private used = 0

  constructor(
    private readonly file: MediaFileLike,
    private readonly budgetBytes: number,
  ) {}

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (length <= 0) return new Uint8Array(0)

    const end = Math.min(offset + length, this.file.size)
    const size = end - offset
    if (this.used + size > this.budgetBytes) throw new MediaValidationError("UNSUPPORTED_MEDIA")
    this.used += size

    const buffer = await this.file.slice(offset, end).arrayBuffer()
    return new Uint8Array(buffer)
  }
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] * 0x1_00_00_00 +
      bytes[offset + 1] * 0x1_00_00 +
      bytes[offset + 2] * 0x1_00 +
      bytes[offset + 3]) >>>
    0
  )
}

function readUint64(bytes: Uint8Array, offset: number): number {
  return readUint32(bytes, offset) * 0x1_00_00_00_00 + readUint32(bytes, offset + 4)
}

function readAscii(bytes: Uint8Array, start: number, end: number): string {
  if (start < 0 || end > bytes.length || start >= end) return ""
  let out = ""
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i])
  return out
}

function readUintBigEndian(bytes: Uint8Array, start: number, end: number): number {
  let value = 0
  for (let i = start; i < end; i++) value = value * 0x100 + bytes[i]
  return value
}

function readFloatBigEndian(bytes: Uint8Array, start: number, end: number): number | null {
  const length = end - start
  if (length !== 4 && length !== 8) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, length)
  return length === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false)
}

// ---------------------------------------------------------------------------
// ISO-BMFF (MP4 / MOV)
// ---------------------------------------------------------------------------

interface IsoBox {
  readonly type: string
  readonly contentStart: number
  readonly end: number
}

const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "mp71",
  "avc1",
  "M4V ",
  "dash",
  "MSNV",
  "F4V ",
  "F4P ",
])

function containerFromBrand(brand: string | null): MediaContainer {
  if (brand === null) return "unknown"
  if (brand === "qt  ") return "mov"
  return MP4_BRANDS.has(brand) ? "mp4" : "unknown"
}

async function readIsoBox(
  reader: SliceReader,
  offset: number,
  limit: number,
): Promise<IsoBox | null> {
  const remaining = limit - offset
  if (remaining < 8) return null

  const header = await reader.read(offset, Math.min(16, remaining))
  const size32 = readUint32(header, 0)
  const type = readAscii(header, 4, 8)

  let headerSize = 8
  let size = size32

  if (size32 === 1) {
    if (header.length < 16) throw new MediaValidationError("UNSUPPORTED_MEDIA")
    size = readUint64(header, 8)
    headerSize = 16
  } else if (size32 === 0) {
    size = remaining
  }

  if (size < headerSize) throw new MediaValidationError("UNSUPPORTED_MEDIA")

  return { type, contentStart: offset + headerSize, end: Math.min(offset + size, limit) }
}

async function findIsoChild(
  reader: SliceReader,
  start: number,
  end: number,
  type: string,
): Promise<IsoBox | null> {
  let offset = start
  for (let iterations = 0; offset < end && iterations < MAX_ITERATIONS; iterations++) {
    const box = await readIsoBox(reader, offset, end)
    if (box === null) return null
    if (box.type === type) return box
    offset = box.end
  }
  return null
}

async function readIsoDurationMs(reader: SliceReader, moov: IsoBox): Promise<number | null> {
  const mvhd = await findIsoChild(reader, moov.contentStart, moov.end, "mvhd")
  if (mvhd === null) return null

  const version = await reader.read(mvhd.contentStart, 1)
  if (version.length < 1) return null

  let timescale: number
  let duration: number

  if (version[0] === 1) {
    const body = await reader.read(mvhd.contentStart, Math.min(32, mvhd.end - mvhd.contentStart))
    if (body.length < 32) return null
    timescale = readUint32(body, 20)
    duration = readUint64(body, 24)
  } else {
    const body = await reader.read(mvhd.contentStart, Math.min(20, mvhd.end - mvhd.contentStart))
    if (body.length < 20) return null
    timescale = readUint32(body, 12)
    duration = readUint32(body, 16)
  }

  if (timescale <= 0 || duration <= 0) return null
  return (duration * 1000) / timescale
}

async function isoHasAudioTrack(reader: SliceReader, moov: IsoBox): Promise<boolean> {
  let offset = moov.contentStart
  for (let iterations = 0; offset < moov.end && iterations < MAX_ITERATIONS; iterations++) {
    const track = await readIsoBox(reader, offset, moov.end)
    if (track === null) return false

    if (track.type === "trak") {
      const mdia = await findIsoChild(reader, track.contentStart, track.end, "mdia")
      if (mdia !== null) {
        const hdlr = await findIsoChild(reader, mdia.contentStart, mdia.end, "hdlr")
        if (hdlr !== null) {
          const body = await reader.read(
            hdlr.contentStart,
            Math.min(12, hdlr.end - hdlr.contentStart),
          )
          if (body.length >= 12 && readAscii(body, 8, 12) === "soun") return true
        }
      }
    }

    offset = track.end
  }
  return false
}

export async function probeIsoBmff(
  file: MediaFileLike,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const reader = new SliceReader(file, options.maxReadBytes ?? MAX_READ_BYTES)

  let brand: string | null = null
  let moov: IsoBox | null = null
  let offset = 0

  for (let iterations = 0; offset < file.size && iterations < MAX_ITERATIONS; iterations++) {
    const box = await readIsoBox(reader, offset, file.size)
    if (box === null) break

    if (box.type === "ftyp" && brand === null) {
      const major = await reader.read(box.contentStart, Math.min(4, box.end - box.contentStart))
      if (major.length === 4) brand = readAscii(major, 0, 4)
    }

    if (box.type === "moov") {
      moov = box
      break
    }

    offset = box.end
  }

  const container = containerFromBrand(brand)
  if (moov === null || container === "unknown") {
    return { container: "unknown", durationMs: 0, hasAudio: false }
  }

  const durationMs = await readIsoDurationMs(reader, moov)
  if (durationMs === null) return { container: "unknown", durationMs: 0, hasAudio: false }

  const hasAudio = await isoHasAudioTrack(reader, moov)
  return { container, durationMs, hasAudio }
}

// ---------------------------------------------------------------------------
// EBML / Matroska (WebM / MKV)
// ---------------------------------------------------------------------------

interface EbmlElement {
  readonly id: number
  readonly contentStart: number
  readonly end: number
  readonly unknownSize: boolean
}

interface Vint {
  readonly value: number
  readonly length: number
  readonly unknown: boolean
}

const EBML_HEADER_ID = 0x1a45dfa3
const EBML_DOC_TYPE_ID = 0x4282
const EBML_SEGMENT_ID = 0x18538067
const EBML_INFO_ID = 0x1549a966
const EBML_TRACKS_ID = 0x1654ae6b
const EBML_TRACK_ENTRY_ID = 0xae
const EBML_TRACK_TYPE_ID = 0x83
const EBML_TIMECODE_SCALE_ID = 0x2ad7b1
const EBML_DURATION_ID = 0x4489
const EBML_CLUSTER_ID = 0x1f43b675

/**
 * Reads an EBML variable-length integer. `keepMarker` keeps the length marker
 * bits, which is required for element IDs but not for sizes.
 */
function readVint(bytes: Uint8Array, offset: number, keepMarker: boolean): Vint | null {
  const first = bytes[offset]
  if (first === undefined || first === 0) return null

  let length = 1
  let mask = 0x80
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1
    length++
  }
  if (length > 8 || offset + length > bytes.length) return null

  const valueBits = mask - 1
  let value = keepMarker ? first : first & valueBits
  let allOnes = (first & valueBits) === valueBits

  for (let i = 1; i < length; i++) {
    const byte = bytes[offset + i]
    value = value * 0x100 + byte
    if (byte !== 0xff) allOnes = false
  }

  return { value, length, unknown: !keepMarker && allOnes }
}

function readEbmlFromBytes(bytes: Uint8Array, offset: number, limit: number): EbmlElement | null {
  if (offset >= limit || offset >= bytes.length) return null

  const id = readVint(bytes, offset, true)
  if (id === null) return null

  const size = readVint(bytes, offset + id.length, false)
  if (size === null) return null

  const contentStart = offset + id.length + size.length
  const end = size.unknown ? limit : Math.min(contentStart + size.value, limit)
  return { id: id.value, contentStart, end, unknownSize: size.unknown }
}

async function readEbmlElement(
  reader: SliceReader,
  offset: number,
  limit: number,
): Promise<EbmlElement | null> {
  const header = await reader.read(offset, Math.min(12, limit - offset))
  const id = readVint(header, 0, true)
  if (id === null) return null

  const size = readVint(header, id.length, false)
  if (size === null) return null

  const contentStart = offset + id.length + size.length
  const end = size.unknown ? limit : Math.min(contentStart + size.value, limit)
  return { id: id.value, contentStart, end, unknownSize: size.unknown }
}

function findEbmlChild(
  bytes: Uint8Array,
  start: number,
  end: number,
  id: number,
): EbmlElement | null {
  let offset = start
  for (let iterations = 0; offset < end && iterations < MAX_ITERATIONS; iterations++) {
    const child = readEbmlFromBytes(bytes, offset, end)
    if (child === null || child.unknownSize) return null
    if (child.id === id) return child
    offset = child.end
  }
  return null
}

function parseMatroskaInfo(
  bytes: Uint8Array,
  start: number,
  end: number,
): { durationS: number | null; timecodeScale: number } {
  let timecodeScale = 1_000_000
  let durationS: number | null = null

  const scale = findEbmlChild(bytes, start, end, EBML_TIMECODE_SCALE_ID)
  if (scale !== null) {
    const value = readUintBigEndian(bytes, scale.contentStart, scale.end)
    if (value > 0) timecodeScale = value
  }

  const duration = findEbmlChild(bytes, start, end, EBML_DURATION_ID)
  if (duration !== null) {
    const value = readFloatBigEndian(bytes, duration.contentStart, duration.end)
    if (value !== null && value > 0) durationS = value
  }

  return { durationS, timecodeScale }
}

function parseMatroskaTracks(bytes: Uint8Array, start: number, end: number): boolean {
  let offset = start
  for (let iterations = 0; offset < end && iterations < MAX_ITERATIONS; iterations++) {
    const entry = readEbmlFromBytes(bytes, offset, end)
    if (entry === null || entry.unknownSize) return false

    if (entry.id === EBML_TRACK_ENTRY_ID) {
      const trackType = findEbmlChild(bytes, entry.contentStart, entry.end, EBML_TRACK_TYPE_ID)
      if (
        trackType !== null &&
        readUintBigEndian(bytes, trackType.contentStart, trackType.end) === 2
      ) {
        return true
      }
    }

    offset = entry.end
  }
  return false
}

export async function probeMatroska(
  file: MediaFileLike,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const reader = new SliceReader(file, options.maxReadBytes ?? MAX_READ_BYTES)

  const header = await readEbmlElement(reader, 0, file.size)
  if (header === null || header.id !== EBML_HEADER_ID) {
    return { container: "unknown", durationMs: 0, hasAudio: false }
  }

  const headerLength = Math.min(header.end - header.contentStart, MAX_EBML_HEADER_BYTES)
  if (headerLength <= 0) return { container: "unknown", durationMs: 0, hasAudio: false }
  const headerBytes = await reader.read(header.contentStart, headerLength)

  const docTypeElement = findEbmlChild(headerBytes, 0, headerBytes.length, EBML_DOC_TYPE_ID)
  const docType =
    docTypeElement === null
      ? ""
      : readAscii(headerBytes, docTypeElement.contentStart, docTypeElement.end)

  const container: MediaContainer =
    docType === "webm" ? "webm" : docType === "matroska" ? "mkv" : "unknown"
  if (container === "unknown") return { container: "unknown", durationMs: 0, hasAudio: false }

  let segment: EbmlElement | null = null
  let offset = header.end
  for (let iterations = 0; offset < file.size && iterations < MAX_ITERATIONS; iterations++) {
    const element = await readEbmlElement(reader, offset, file.size)
    if (element === null) break
    if (element.id === EBML_SEGMENT_ID) {
      segment = element
      break
    }
    offset = element.end
  }

  if (segment === null) return { container: "unknown", durationMs: 0, hasAudio: false }

  let durationS: number | null = null
  let timecodeScale = 1_000_000
  let hasAudio = false

  offset = segment.contentStart
  for (let iterations = 0; offset < segment.end && iterations < MAX_ITERATIONS; iterations++) {
    const element = await readEbmlElement(reader, offset, segment.end)
    if (element === null || element.unknownSize) break

    if (element.id === EBML_INFO_ID || element.id === EBML_TRACKS_ID) {
      const limit = element.id === EBML_INFO_ID ? MAX_INFO_BYTES : MAX_TRACKS_BYTES
      const length = element.end - element.contentStart
      if (length <= 0 || length > limit) throw new MediaValidationError("UNSUPPORTED_MEDIA")
      const bytes = await reader.read(element.contentStart, length)

      if (element.id === EBML_INFO_ID) {
        const info = parseMatroskaInfo(bytes, 0, bytes.length)
        durationS = info.durationS
        timecodeScale = info.timecodeScale
      } else {
        hasAudio = parseMatroskaTracks(bytes, 0, bytes.length)
      }
    }

    if (element.id === EBML_CLUSTER_ID) break
    offset = element.end
  }

  if (durationS === null) return { container: "unknown", durationMs: 0, hasAudio: false }

  return { container, durationMs: (durationS * timecodeScale) / 1_000_000, hasAudio }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface NavigatorWithUserAgentData {
  readonly userAgent: string
  readonly userAgentData?: { readonly mobile?: boolean }
}

function isMobileDevice(injected: boolean | undefined): boolean {
  if (injected !== undefined) return injected
  const nav: NavigatorWithUserAgentData = navigator
  if (nav.userAgentData?.mobile !== undefined) return nav.userAgentData.mobile
  return /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent)
}

function hasEbmlMagic(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
}

export async function validateMediaFile(
  file: MediaFileLike,
  options: ValidateOptions = {},
): Promise<MediaInfo> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS

  if (isMobileDevice(options.isMobile)) throw new MediaValidationError("UNSUPPORTED_DEVICE")
  if (file.size > maxBytes) throw new MediaValidationError("FILE_TOO_LARGE")
  if (file.size < 8) throw new MediaValidationError("UNSUPPORTED_MEDIA")

  const head = await new SliceReader(file, options.maxReadBytes ?? MAX_READ_BYTES).read(
    0,
    Math.min(12, file.size),
  )
  const probeOptions: ProbeOptions = { maxReadBytes: options.maxReadBytes }

  let result: ProbeResult
  try {
    if (hasEbmlMagic(head)) {
      result = await probeMatroska(file, probeOptions)
    } else if (readAscii(head, 4, 8) === "ftyp") {
      result = await probeIsoBmff(file, probeOptions)
    } else {
      throw new MediaValidationError("UNSUPPORTED_MEDIA")
    }

    if (result.container === "unknown" || !Number.isFinite(result.durationMs)) {
      throw new MediaValidationError("UNSUPPORTED_MEDIA")
    }
    if (result.durationMs > maxDurationMs) throw new MediaValidationError("DURATION_EXCEEDED")
    if (!result.hasAudio) throw new MediaValidationError("NO_AUDIO_TRACK")
  } catch (error) {
    if (import.meta.env.DEV) {
      // biome-ignore lint/suspicious/noConsole: dev-only diagnostic, never exposed to the user
      console.error("[media-guard] validacion fallida", error)
    }
    throw error
  }

  return result
}
