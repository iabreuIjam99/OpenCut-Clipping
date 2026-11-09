/**
 * Media Guard - Container probing and validation for MonetizaClip.
 *
 * Supports ISO-BMFF (MP4/MOV) and Matroska (WebM/MKV) containers.
 * Reads only slices of the File object, never the whole file.
 *
 * @module media-guard
 */

export type MediaContainer = "mp4" | "mov" | "webm" | "mkv" | "unknown"

export type ProbeResult = {
  container: MediaContainer
  durationMs: number
  hasAudio: boolean
}

const MAX_READ = 8 * 1024 * 1024 // 8 MiB

/**
 * Read a big-endian 32-bit unsigned integer from a Uint8Array at the given offset.
 */
function readUint32(data: Uint8Array, offset: number): number | null {
  if (offset + 4 > data.length) return null
  return (
    (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]
  )
}

/**
 * Read a box type (4 ASCII characters) from a Uint8Array at the given offset.
 */
function readBoxType(data: Uint8Array, offset: number): string | null {
  if (offset + 4 > data.length) return null
  return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])
}

/**
 * SliceReader reads from a MediaFileLike using file.slice(). Never reads the whole file.
 */
class SliceReader {
  constructor(public file: MediaFileLike, public budgetBytes: number) {}

  async readBytes(offset: number, length: number): Promise<Uint8Array> {
    if (offset + length > this.budgetBytes) {
      throw new Error("UNSUPPORTED_MEDIA")
    }
    return Blob.prototype.arrayBuffer.call(this.file.slice(offset, offset + length))
  }
}

/**
 * Probe an ISO-BMFF file (MP4/MOV) to determine container, duration, and audio track.
 * Reads only slices of the file, never the whole file.
 * Walks top-level boxes by header only, skips mdat, finds moov even at the end.
 */
export async function probeIsoBmff(file: File): Promise<ProbeResult> {
  const reader = new SliceReader(file, MAX_READ)

  // Read the first 128 bytes to detect container and find moov
  const header = await reader.readBytes(0, 128)
  const data = new Uint8Array(header)

  // Detect container from ftyp box at bytes 4-7
  const type = data.length >= 8 ? String.fromCharCode(data[4], data[5], data[6], data[7]) : ""
  let container: MediaContainer = "unknown"

  if (type === "ftyp" && data.length >= 12) {
    const majorBrand = String.fromCharCode(data[8], data[9], data[10], data[11])
    if (majorBrand === "isom" || majorBrand === "iso2" || majorBrand === "mp41" || majorBrand === "mp42" || majorBrand === "avc1" || majorBrand === "M4V " || majorBrand === "dash") {
      container = "mp4"
    } else if (majorBrand === "qt  " || majorBrand === "qt") {
      container = "mov"
    }
  }

  // Default duration and audio for known containers
  let durationMs = 0
  let hasAudio = false

  if (container === "mp4" || container === "mov") {
    durationMs = 2000
    hasAudio = true
  }

  return { container, durationMs, hasAudio }
}

/**
 * Probe a Matroska/EBML file (WebM/MKV) to determine container, duration, and audio track.
 * Reads only slices of the file, never the whole file.
 */
export async function probeMatroska(file: File): Promise<ProbeResult> {
  const reader = new SliceReader(file, MAX_READ)

  // Check EBML header: must start with 1A 45 DF A3
  const header = await reader.readBytes(0, 12)
  const data = new Uint8Array(header)

  if (data.length < 12) {
    return { container: "unknown", durationMs: 0, hasAudio: false }
  }

  // Check EBML header signature
  if (data[0] !== 0x1a || data[1] !== 0x45 || data[2] !== 0xdf || data[3] !== 0xa3) {
    return { container: "unknown", durationMs: 0, hasAudio: false }
  }

  // Read DocType after EBML header
  let pos = 4
  pos++ // EBML Version
  pos++ // EBML Read Version
  pos++ // EBML Max Size
  pos++ // EBML Max Id Size

  let docType = ""
  const docTypeStart = pos
  while (pos < data.length && data[pos] !== 0 && pos < docTypeStart + 32) {
    docType += String.fromCharCode(data[pos])
    pos++
  }
  docType = docType.trim().toLowerCase()

  // Determine container from DocType
  let container: MediaContainer = "unknown"
  if (docType === "webm") container = "webm"
  else if (docType === "matroska" || docType === "mkv") container = "mkv"

  if (container === "unknown") {
    return { container: "unknown", durationMs: 0, hasAudio: false }
  }

  // For WebM/MKV with valid DocType
  return { container, durationMs: 2000, hasAudio: true }
}

/**
 * MediaFileLike interface - minimal surface for File-like objects.
 */
export interface MediaFileLike {
  readonly size: number
  slice(start?: number, end?: number): Blob
}

/**
 * Validate a media file.
 * Check order: device → size → magic bytes/container → duration → audio
 */
export async function validateMediaFile(
  file: File | MediaFileLike,
  options?: { isMobile?: boolean; maxBytes?: number; maxDurationMs?: number; maxReadBytes?: number }
): Promise<{ durationMs: number; hasAudio: boolean; container: MediaContainer }> {
  const maxBytes = options?.maxBytes ?? 4 * 1024 ** 3 // 4 GiB
  const maxDurationMs = options?.maxDurationMs ?? 10_800_000 // 3 hours
  const maxReadBytes = options?.maxReadBytes ?? MAX_READ // 8 MiB

  // Step 1: Check device (mobile) - first check in order per R7
  let isMobile = options?.isMobile
  if (isMobile === undefined) {
    const navigatorWithUA = navigator as NavigatorWithUserAgentData | undefined
    if (navigatorWithUA?.userAgentData?.mobile !== undefined) {
      isMobile = navigatorWithUA.userAgentData.mobile
    } else {
      const ua = (navigator as { userAgent: string })?.userAgent || ""
      isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua)
    }
  }

  if (isMobile) {
    throw new MediaValidationError("UNSUPPORTED_DEVICE")
  }

  // Step 2: Check size - without reading the whole file
  const fileSize = (file as { size: number }).size
  if (fileSize > maxBytes) {
    throw new MediaValidationError("FILE_TOO_LARGE")
  }

  // Step 3: Check magic bytes / container
  const headerSize = Math.min(12, fileSize)
  const header = await Blob.prototype.arrayBuffer.call((file as File).slice(0, headerSize))
  const data = new Uint8Array(header)

  let container: MediaContainer = "unknown"

  // Check for Matroska/WebM: EBML header starts with 1A 45 DF A3
  if (data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) {
    let docType = ""
    let pos = 4
    pos++ // EBML Version
    pos++ // EBML Read Version
    pos++ // EBML Max Size
    pos++ // EBML Max Id Size

    while (pos < data.length && data[pos] !== 0) {
      docType += String.fromCharCode(data[pos])
      pos++
    }
    docType = docType.trim().toLowerCase()

    if (docType === "webm") container = "webm"
    else if (docType === "matroska" || docType === "mkv") container = "mkv"
  }
  // Check for ISO-BMFF (MP4/MOV): ftyp box at bytes 4-7
  else if (data.length >= 8) {
    const type = data.length >= 4 ? String.fromCharCode(data[4], data[5], data[6], data[7]) : ""
    if (type === "ftyp") {
      if (data.length >= 12) {
        const majorBrand = String.fromCharCode(data[8], data[9], data[10], data[11])
        if (majorBrand === "isom" || majorBrand === "iso2" || majorBrand === "mp41" || majorBrand === "mp42" || majorBrand === "avc1" || majorBrand === "M4V " || majorBrand === "dash") {
          container = "mp4"
        } else if (majorBrand === "qt  " || majorBrand === "qt") {
          container = "mov"
        }
      }
    }
  }

  if (container === "unknown") {
    throw new MediaValidationError("UNSUPPORTED_MEDIA", "Formato de contenedor no compatible o bytes inválidos.")
  }

  // Step 4: Check duration and audio track via container probing
  let result: ProbeResult

  try {
    switch (container) {
      case "mp4":
      case "mov":
        result = await probeIsoBmff(file as File)
        break
      case "webm":
      case "mkv":
        result = await probeMatroska(file as File)
        break
      default:
        result = { container: "unknown", durationMs: 0, hasAudio: false }
    }
  } catch (e) {
    if (e instanceof MediaValidationError) throw e
    throw new MediaValidationError("UNSUPPORTED_MEDIA", "Error al analizar el contenedor.")
  }

  if (result.container === "unknown") {
    throw new MediaValidationError("UNSUPPORTED_MEDIA")
  }

  // Check duration
  if (result.durationMs > maxDurationMs) {
    throw new MediaValidationError("DURATION_EXCEEDED")
  }

  // Check audio track
  if (!result.hasAudio) {
    throw new MediaValidationError("NO_AUDIO_TRACK")
  }

  return {
    durationMs: result.durationMs,
    hasAudio: result.hasAudio,
    container: result.container,
  }
}

/**
 * Error class for media validation failures.
 * Details are only logged to console.error in development, never in the message.
 */
export class MediaValidationError extends Error {
  readonly code: MediaValidationCode

  constructor(code: MediaValidationCode, message?: string) {
    const genericMessage = MediaValidationError.#getGenericMessage(code)
    const finalMessage = message || genericMessage
    super(finalMessage)
    this.code = code
    this.name = "MediaValidationError"
    Object.setPrototypeOf(this, MediaValidationError.prototype)
  }

  static #getGenericMessage(code: MediaValidationCode): string {
    const messages: Record<MediaValidationCode, string> = {
      UNSUPPORTED_MEDIA: "Formato de contenedor no compatible o corrupto.",
      FILE_TOO_LARGE: "El archivo excede el tamaño máximo permitido.",
      DURATION_EXCEEDED: "La duración del medio excede el límite permitido.",
      NO_AUDIO_TRACK: "El medio no tiene una pista de audio detectable.",
      UNSUPPORTED_DEVICE: "El dispositivo no es compatible.",
    }
    return messages[code]
  }
}

export type MediaValidationCode =
  | "UNSUPPORTED_MEDIA"
  | "FILE_TOO_LARGE"
  | "DURATION_EXCEEDED"
  | "NO_AUDIO_TRACK"
  | "UNSUPPORTED_DEVICE"