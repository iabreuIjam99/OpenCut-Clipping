import { describe, expect, it } from "vitest"
import fixture from "./__fixtures__/whisper-base-10s.json"
import { isTranscribeRequest, isTranscribeResponse, toSegments } from "./transcribe-protocol"

/**
 * Pure protocol tests (Task 12, R4/R5/R7): `toSegments` maps the real ASR
 * output shape to absolute milliseconds and never throws; the two guards
 * validate both directions of the Worker boundary — the Worker is untrusted
 * input, exactly like an external `postMessage`.
 */

// ---------------------------------------------------------------------------
// toSegments (R5)
// ---------------------------------------------------------------------------

describe("toSegments", () => {
  it("maps the whisper-base 10 s fixture to absolute-millisecond segments", () => {
    const segments = toSegments(fixture, 10_000)

    expect(segments).toEqual([
      { startMs: 0, endMs: 2840, text: " Buenas tardes." },
      { startMs: 2840, endMs: 6420, text: " Esto es una prueba de" },
      { startMs: 6420, endMs: 10_000, text: " transcripción local con Whisper." },
    ])
    expect(segments[2]?.text).toContain("transcripción")
  })

  it("closes a null end timestamp at durationMs", () => {
    const segments = toSegments(
      { text: " hola", chunks: [{ timestamp: [1, null], text: " hola" }] },
      5000,
    )

    expect(segments).toEqual([{ startMs: 1000, endMs: 5000, text: " hola" }])
  })

  it("stably orders out-of-order chunks by startMs, preserving text and times", () => {
    const segments = toSegments(
      {
        text: "b a c",
        chunks: [
          { timestamp: [2, 3], text: " b" },
          { timestamp: [0, 1], text: " a" },
          { timestamp: [4, null], text: " c" },
        ],
      },
      5000,
    )

    expect(segments).toEqual([
      { startMs: 0, endMs: 1000, text: " a" },
      { startMs: 2000, endMs: 3000, text: " b" },
      { startMs: 4000, endMs: 5000, text: " c" },
    ])
    expect(segments.map((segment) => segment.startMs)).toEqual([0, 2000, 4000])
  })

  it("keeps arrival order for chunks that start at the same instant (stable sort)", () => {
    const segments = toSegments(
      {
        text: "uno dos",
        chunks: [
          { timestamp: [1, 2], text: " uno" },
          { timestamp: [1, 3], text: " dos" },
        ],
      },
      3000,
    )

    expect(segments.map((segment) => segment.text)).toEqual([" uno", " dos"])
  })

  it("clamps timestamps to the [0, durationMs] range", () => {
    const segments = toSegments(
      {
        text: "x",
        chunks: [
          { timestamp: [-4, 1], text: " antes del inicio" },
          { timestamp: [8, 20], text: " más allá del final" },
          { timestamp: [9, 3], text: " fin antes del inicio" },
        ],
      },
      10_000,
    )

    expect(segments).toEqual([
      { startMs: 0, endMs: 1000, text: " antes del inicio" },
      { startMs: 8000, endMs: 10_000, text: " más allá del final" },
      { startMs: 9000, endMs: 9000, text: " fin antes del inicio" },
    ])
  })

  it("drops chunks with blank text without poisoning their siblings", () => {
    const segments = toSegments(
      {
        text: " útil",
        chunks: [
          { timestamp: [0, 1], text: "   " },
          { timestamp: [1, 2], text: " útil" },
          { timestamp: [2, 3], text: "\n\t " },
        ],
      },
      3000,
    )

    expect(segments).toEqual([{ startMs: 1000, endMs: 2000, text: " útil" }])
  })

  it("returns a single [0, durationMs] segment when chunks are absent", () => {
    expect(toSegments({ text: " sin chunks" }, 4000)).toEqual([
      { startMs: 0, endMs: 4000, text: " sin chunks" },
    ])
    expect(toSegments({ text: " chunks vacíos", chunks: [] }, 4000)).toEqual([
      { startMs: 0, endMs: 4000, text: " chunks vacíos" },
    ])
  })

  it("returns [] for unrecognizable output", () => {
    expect(toSegments(null, 1000)).toEqual([])
    expect(toSegments(undefined, 1000)).toEqual([])
    expect(toSegments("texto", 1000)).toEqual([])
    expect(toSegments(42, 1000)).toEqual([])
    expect(toSegments([], 1000)).toEqual([])
    expect(toSegments({}, 1000)).toEqual([])
    expect(toSegments({ chunks: "no" }, 1000)).toEqual([])
    expect(toSegments({ text: 7 }, 1000)).toEqual([])
    expect(toSegments({ text: " ", chunks: [] }, 1000)).toEqual([])
  })

  it("returns [] when durationMs is unusable and never throws", () => {
    expect(toSegments(fixture, Number.NaN)).toEqual([])
    expect(toSegments(fixture, 0)).toEqual([])
    expect(toSegments(fixture, -1000)).toEqual([])
    expect(toSegments(fixture, Number.POSITIVE_INFINITY)).toEqual([])
  })

  it("skips malformed chunks without throwing", () => {
    const segments = toSegments(
      {
        text: "t",
        chunks: [
          null,
          "chunk",
          { timestamp: "0-1", text: " sin array" },
          { timestamp: [Number.NaN, 1], text: " start NaN" },
          { timestamp: [0, 1] },
          { timestamp: [1, Number.NaN], text: " fin desconocido" },
          { timestamp: [1, 2], text: " válida" },
        ],
      },
      5000,
    )

    expect(segments).toEqual([
      { startMs: 1000, endMs: 5000, text: " fin desconocido" },
      { startMs: 1000, endMs: 2000, text: " válida" },
    ])
  })
})

// ---------------------------------------------------------------------------
// isTranscribeResponse / isTranscribeRequest (R4)
// ---------------------------------------------------------------------------

describe("isTranscribeResponse", () => {
  it("accepts the three valid messages and rejects garbage or null", () => {
    expect(isTranscribeResponse({ type: "progress", progress: 0.5 })).toBe(true)
    expect(
      isTranscribeResponse({
        type: "result",
        device: "webgpu",
        segments: [{ startMs: 0, endMs: 1, text: "hola" }],
      }),
    ).toBe(true)
    expect(isTranscribeResponse({ type: "result", device: "wasm", segments: [] })).toBe(true)
    expect(isTranscribeResponse({ type: "error", code: "TRANSCRIPTION_FAILED" })).toBe(true)
    expect(isTranscribeResponse({ type: "error", code: "NO_AUDIO" })).toBe(true)

    expect(isTranscribeResponse(null)).toBe(false)
    expect(isTranscribeResponse(undefined)).toBe(false)
    expect(isTranscribeResponse("progress")).toBe(false)
    expect(isTranscribeResponse([])).toBe(false)
    expect(isTranscribeResponse({})).toBe(false)
    expect(isTranscribeResponse({ type: "progress", progress: "50" })).toBe(false)
    expect(isTranscribeResponse({ type: "progress", progress: Number.NaN })).toBe(false)
    expect(isTranscribeResponse({ type: "result", device: "cpu", segments: [] })).toBe(false)
    expect(
      isTranscribeResponse({
        type: "result",
        device: "wasm",
        segments: [{ startMs: "0", endMs: 1, text: "x" }],
      }),
    ).toBe(false)
    expect(isTranscribeResponse({ type: "error", code: "ECONNRESET" })).toBe(false)
    expect(isTranscribeResponse({ type: "unknown" })).toBe(false)
  })
})

describe("isTranscribeRequest", () => {
  const request = {
    type: "transcribe",
    audio: new Float32Array(16),
    durationMs: 1000,
    model: "base",
    language: "es",
  }

  it("accepts a well-formed request only for the supported model", () => {
    expect(isTranscribeRequest(request)).toBe(true)
    expect(isTranscribeRequest({ ...request, model: "base" })).toBe(true)
    expect(isTranscribeRequest({ ...request, model: "small" })).toBe(false)
    expect(isTranscribeRequest({ ...request, model: "large" })).toBe(false)
  })

  it("rejects malformed requests before they can reach the model", () => {
    expect(isTranscribeRequest(null)).toBe(false)
    expect(isTranscribeRequest({ ...request, type: "transcribe2" })).toBe(false)
    expect(isTranscribeRequest({ ...request, audio: new ArrayBuffer(64) })).toBe(false)
    expect(isTranscribeRequest({ ...request, audio: undefined })).toBe(false)
    expect(isTranscribeRequest({ ...request, durationMs: Number.NaN })).toBe(false)
    expect(isTranscribeRequest({ ...request, durationMs: "1000" })).toBe(false)
    expect(isTranscribeRequest({ ...request, model: "large" })).toBe(false)
    expect(isTranscribeRequest({ ...request, language: 42 })).toBe(false)
  })
})
