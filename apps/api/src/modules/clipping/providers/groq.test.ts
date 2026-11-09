import { describe, expect, it } from "vitest"
import type { TranscriptResult } from "./groq"
import { toTranscript } from "./groq"

function mapped(payload: unknown, durationMs?: number): TranscriptResult {
  const result = toTranscript(payload, durationMs)
  if (!result) throw new Error("esperaba una transcripción reconocible")
  return result
}

describe("toTranscript - pure mapping", () => {
  it("should map segments with valid start/end/text and clamp to duration", () => {
    const payload = {
      language: "en",
      segments: [
        { start: 0, end: 5, text: "hello" },
        { start: 10, end: 15, text: "world" },
      ],
    }
    const result = mapped(payload, 12_000) // duration = 12s
    expect(result).toEqual(
      expect.objectContaining({
        segments: expect.arrayContaining([
          expect.objectContaining({ startMs: 0, endMs: 5_000, text: "hello" }),
          expect.objectContaining({ startMs: 10_000, endMs: 12_000, text: "world" }),
        ]),
        language: "en",
      }),
    )
    // Verify clamping: second segment end is 15s > duration 12s, should be clamped
    expect(result.segments[1].endMs).toBe(12_000)
  })

  it("should drop segments with non-finite start/end", () => {
    const payload = {
      language: "en",
      segments: [
        { start: 0, end: 5, text: "ok" },
        { start: NaN, end: 5, text: "bad start" },
        { start: 0, end: Infinity, text: "bad end" },
        { start: -1, end: 5, text: "negative start" },
        { start: 0, end: -1, text: "negative end" },
      ],
    }
    const result = mapped(payload)
    expect(result.segments).toHaveLength(1) // only the first one
    expect(result.segments[0].text).toBe("ok")
  })

  it("should drop segments with text empty/whitespace after trim", () => {
    const payload = {
      language: "en",
      segments: [
        { start: 0, end: 5, text: "hello" },
        { start: 10, end: 15, text: "   " },
        { start: 20, end: 25, text: "" },
      ],
    }
    const result = mapped(payload)
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0].text).toBe("hello")
  })

  it("should fallback language to 'und' when missing or empty", () => {
    // Missing language
    const result = mapped({ segments: [{ start: 0, end: 5, text: "hola" }] })
    expect(result.language).toBe("und")

    // Empty language
    const result2 = mapped({ language: "", segments: [{ start: 0, end: 5, text: "hola" }] })
    expect(result2.language).toBe("und")

    // Whitespace-only language
    const result3 = mapped({ language: "  ", segments: [{ start: 0, end: 5, text: "hola" }] })
    expect(result3.language).toBe("und")
  })

  it("should handle empty payload", () => {
    const result = toTranscript(undefined, undefined)
    expect(result).toBeNull()
  })

  it("should handle null payload", () => {
    const result = toTranscript(null, undefined)
    expect(result).toBeNull()
  })

  it("should handle payload with text-only (no segments) and duration", () => {
    const result = mapped({ text: "solo texto" }, 8_000)
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0].startMs).toBe(0)
    expect(result.segments[0].endMs).toBe(8_000)
    expect(result.segments[0].text).toBe("solo texto")
    expect(result.language).toBe("und")
  })

  it("should handle payload with text-only (no segments) without duration", () => {
    const result = mapped({ text: "solo texto" })
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0].startMs).toBe(0)
    expect(result.segments[0].endMs).toBe(0)
    expect(result.segments[0].text).toBe("solo texto")
    expect(result.language).toBe("und")
  })

  it("should stable sort segments by startMs", () => {
    const payload = {
      language: "en",
      segments: [
        { start: 15, end: 20, text: "last" },
        { start: 0, end: 5, text: "first" },
        { start: 10, end: 15, text: "middle" },
      ],
    }
    const result = mapped(payload)
    expect(result.segments[0].text).toBe("first")
    expect(result.segments[1].text).toBe("middle")
    expect(result.segments[2].text).toBe("last")
  })

  it("should handle segments missing start/end/text properties", () => {
    const payload = {
      language: "en",
      segments: [
        { start: 0, text: "missing end" },
        { end: 5, text: "missing start" },
        { text: "missing both" },
        {}, // empty object
      ],
    }
    // Payload has a segments array → returns { segments, language } even if all segments are invalid
    // Silencio no es error: segments: [] y/o text: "" devuelve { segments, language }
    const result = mapped(payload)
    expect(result).toEqual({ segments: [], language: "en" })
  })

  it("should handle duration clamping edge cases", () => {
    // Reversed start > end, but both finite and non-negative, with duration
    const payload = {
      language: "en",
      segments: [{ start: 10, end: 5, text: "reversed" }],
      duration: 3_000,
    }
    const result = mapped(payload, 3_000)
    expect(result.segments).toHaveLength(1)
    // After clamping: startMs = max(0, min(10000, 3000)) = 3000
    // endMs = max(3000, min(5000, 3000)) = max(3000, 3000) = 3000
    expect(result.segments[0].startMs).toBe(3000)
    expect(result.segments[0].endMs).toBe(3000)
  })

  it("should enforce start <= end when no duration provided", () => {
    const result = toTranscript({
      segments: [{ start: 10, end: 5, text: "x" }],
    }) as TranscriptResult
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0].startMs).toBe(10_000)
    expect(result.segments[0].endMs).toBe(10_000)
  })

  it("should handle silent audio: { segments: [], text: '' } → { segments: [], language: 'und' }", () => {
    const result = mapped({ segments: [], text: "" })
    expect(result).toEqual({ segments: [], language: "und" })
  })

  it("should handle text-only without duration returns segment with endMs=0", () => {
    const result = mapped({ text: "hola" })
    expect(result).not.toBeNull()
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0].endMs).toBe(0)
  })

  it("should handle segments non-array payload with text", () => {
    const result = mapped({ segments: "not-an-array", text: "hola" })
    expect(result).not.toBeNull()
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0].text).toBe("hola")
    expect(result.segments[0].startMs).toBe(0)
    expect(result.segments[0].endMs).toBe(0)
  })

  it("should handle segments with mixed valid/invalid elements", () => {
    const result = mapped({
      segments: [null, "x", 42, { start: 0, end: 1, text: "ok" }],
    })
    expect(result).not.toBeNull()
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0].text).toBe("ok")
  })
})
