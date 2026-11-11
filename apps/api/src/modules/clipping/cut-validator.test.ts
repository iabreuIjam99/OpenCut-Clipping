import { describe, expect, it } from "vitest"
import { validateCuts } from "./cut-validator"

describe("validateCuts", () => {
  const media15s = { durationMs: 15_000 }
  const media180s = { durationMs: 180_000 }
  const media200s = { durationMs: 200_000 }
  const media315s = { durationMs: 315_000 }

  // R1: Boundary durations
  it("acepta 15_000 y 180_000, descarta 14_999 y 180_001", () => {
    expect(
      validateCuts([{ startMs: 0, endMs: 15_000, title: "a", score: 1 }], media15s).length,
    ).toBe(1)
    expect(
      validateCuts([{ startMs: 0, endMs: 180_000, title: "a", score: 1 }], media180s).length,
    ).toBe(1)
    expect(
      validateCuts([{ startMs: 0, endMs: 14_999, title: "a", score: 1 }], media15s).length,
    ).toBe(0)
    expect(
      validateCuts([{ startMs: 0, endMs: 180_001, title: "a", score: 1 }], media180s).length,
    ).toBe(0)
    // Invalid media
    expect(
      validateCuts([{ startMs: 0, endMs: 15_000, title: "a", score: 1 }], { durationMs: 10_000 })
        .length,
    ).toBe(0)
  })

  // R2: Rango inválido
  it("descarta start/end no numéricos o no finitos", () => {
    const valid = { endMs: 15_000, title: "a", score: 1 }
    expect(validateCuts([{ ...valid, startMs: "0" }], media15s)).toEqual([])
    expect(validateCuts([{ startMs: 0, title: "a", score: 1 }], media15s)).toEqual([])
    expect(validateCuts([{ ...valid, startMs: Number.NaN }], media15s)).toEqual([])
    expect(
      validateCuts(
        [{ startMs: 0, endMs: Number.POSITIVE_INFINITY, title: "a", score: 1 }],
        media15s,
      ),
    ).toEqual([])
    expect(
      validateCuts([{ startMs: 0, endMs: 15_000, title: "a", score: 1 }], media15s),
    ).toHaveLength(1)
  })

  it("descarta start < 0, start === end, end > durationMs", () => {
    expect(
      validateCuts([{ startMs: -1, endMs: 15_000, title: "a", score: 1 }], media15s).length,
    ).toBe(0)
    expect(validateCuts([{ startMs: 0, endMs: 0, title: "a", score: 1 }], media15s).length).toBe(0)
    expect(
      validateCuts([{ startMs: 0, endMs: 16_000, title: "a", score: 1 }], media15s).length,
    ).toBe(0)
  })

  // R3: Geometra válida
  it("acepta corte con duración válida dentro de media", () => {
    const result = validateCuts(
      [{ startMs: 10_000, endMs: 25_000, title: "hola", score: 0.5 }],
      media200s,
    )
    expect(result).toHaveLength(1)
    expect(result[0].startMs).toBe(10_000)
    expect(result[0].endMs).toBe(25_000)
  })

  it("descarta título ausente o no string", () => {
    expect(validateCuts([{ startMs: 0, endMs: 15_000, score: 1 }], media15s)).toEqual([])
    expect(validateCuts([{ startMs: 0, endMs: 15_000, title: 42, score: 1 }], media15s)).toEqual([])
    expect(validateCuts([{ startMs: 0, endMs: 15_000, title: null, score: 1 }], media15s)).toEqual(
      [],
    )
  })

  it("descarta título vacío, >80 codepoints, con <>, con caracteres de control", () => {
    expect(
      validateCuts([{ startMs: 0, endMs: 15_000, title: "", score: 1 }], media15s).length,
    ).toBe(0)
    const longTitle = "a".repeat(81)
    expect(
      validateCuts([{ startMs: 0, endMs: 15_000, title: longTitle, score: 1 }], media15s).length,
    ).toBe(0)
    expect(
      validateCuts([{ startMs: 0, endMs: 15_000, title: "<script>", score: 1 }], media15s).length,
    ).toBe(0)
    expect(
      validateCuts([{ startMs: 0, endMs: 15_000, title: "a>b", score: 1 }], media15s).length,
    ).toBe(0)
    expect(
      validateCuts([{ startMs: 0, endMs: 15_000, title: "a\tb", score: 1 }], media15s).length,
    ).toBe(0)
    expect(
      validateCuts([{ startMs: 0, endMs: 15_000, title: "a\x00b", score: 1 }], media15s).length,
    ).toBe(0)
    const exactTitle = "a".repeat(80)
    const result = validateCuts(
      [{ startMs: 0, endMs: 15_000, title: exactTitle, score: 1 }],
      media15s,
    )
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe(exactTitle)
  })

  // R5: Score
  it("clampa score a [0,1]; score no numérico descarta el corte", () => {
    expect(
      validateCuts([{ startMs: 0, endMs: 15_000, title: "a", score: 0.5 }], media15s),
    ).toMatchObject([{ score: 0.5 }])
    expect(
      validateCuts([{ startMs: 0, endMs: 15_000, title: "a", score: 2 }], media15s),
    ).toMatchObject([{ score: 1 }])
    expect(
      validateCuts([{ startMs: 0, endMs: 15_000, title: "a", score: 1.5 }], media15s),
    ).toMatchObject([{ score: 1 }])
    expect(
      validateCuts([{ startMs: 0, endMs: 15_000, title: "a", score: -0.5 }], media15s),
    ).toMatchObject([{ score: 0 }])
    expect(
      validateCuts([{ startMs: 0, endMs: 15_000, title: "a", score: -1 }], media15s),
    ).toMatchObject([{ score: 0 }])
    expect(
      validateCuts([{ startMs: 0, endMs: 15_000, title: "a", score: 0 }], media15s),
    ).toMatchObject([{ score: 0 }])
    expect(
      validateCuts([{ startMs: 0, endMs: 15_000, title: "a", score: 1 }], media15s),
    ).toMatchObject([{ score: 1 }])
    expect(validateCuts([{ startMs: 0, endMs: 15_000, title: "a" }], media15s)).toEqual([])
    expect(
      validateCuts([{ startMs: 0, endMs: 15_000, title: "a", score: "0.5" }], media15s),
    ).toEqual([])
    expect(
      validateCuts([{ startMs: 0, endMs: 15_000, title: "a", score: null }], media15s),
    ).toEqual([])
    expect(validateCuts([{ startMs: 0, endMs: 15_000, title: "a", score: NaN }], media15s)).toEqual(
      [],
    )
    expect(
      validateCuts([{ startMs: 0, endMs: 15_000, title: "a", score: Infinity }], media15s),
    ).toEqual([])
  })

  // R6: ID determinista
  it("genera id clip fijo", () => {
    const result = validateCuts([{ startMs: 0, endMs: 15_000, title: "a", score: 1 }], media15s)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("clip-0-15000")
  })

  // R7: Duplicados por IoU > 0.8
  it("colapsa duplicados IoU > 0.8 conservando mayor score", () => {
    const cuts = [
      { startMs: 0, endMs: 15_000, title: "first", score: 0.5 },
      { startMs: 0, endMs: 15_000, title: "second", score: 0.8 },
    ]
    const result = validateCuts(cuts, media15s)
    expect(result).toHaveLength(1)
    expect(result[0].score).toBe(0.8)
  })

  // Two non-overlapping cuts should both be kept
  it("mantiene cortes no superpuestos", () => {
    const cuts = [
      { startMs: 0, endMs: 15_000, title: "a", score: 0.5 },
      { startMs: 20_000, endMs: 35_000, title: "b", score: 0.8 },
    ]
    const result = validateCuts(cuts, media180s)
    expect(result).toHaveLength(2)
  })

  // 21 cortes → máximo 20 en la salida
  it("capa a 20 cortes máximo", () => {
    const cuts = Array.from({ length: 21 }, (_, i) => ({
      startMs: i * 15_000,
      endMs: (i + 1) * 15_000,
      title: `t${i}`,
      score: 1,
    }))
    const result = validateCuts(cuts, media315s)
    expect(result).toHaveLength(20)
    // Should be sorted by startMs ascending
    for (let i = 1; i < result.length; i++) {
      expect(result[i].startMs).toBeGreaterThanOrEqual(result[i - 1].startMs)
    }
  })

  // Entrada hostil
  it("devuelve [] para entradas hostiles sin lanzar", () => {
    expect(validateCuts(null, media15s)).toEqual([])
    expect(validateCuts(42, media15s)).toEqual([])
    expect(validateCuts("x", media15s)).toEqual([])
    expect(validateCuts([], media15s)).toEqual([])
    expect(validateCuts({ cuts: "x" }, media15s)).toEqual([])
    expect(validateCuts([null, 42, "x"], media15s)).toEqual([])
  })

  // Determinismo: inputs no superpuestos producen misma salida
  it("mismo input produce misma salida", () => {
    const input = [
      { startMs: 0, endMs: 15_000, title: "a", score: 0.5 },
      { startMs: 20_000, endMs: 35_000, title: "b", score: 0.8 },
    ]
    const r1 = validateCuts(input, media315s)
    const r2 = validateCuts(input, media315s)
    expect(r1).toEqual(r2)
    expect(r1[0].id).toBe(r2[0].id)
    expect(r1[1].id).toBe(r2[1].id)
  })

  // Test para cobertura 100%: entrada con cuts prop
  it("acepta formato { cuts: unknown[] }", () => {
    const result = validateCuts(
      { cuts: [{ startMs: 0, endMs: 15_000, title: "a", score: 1 }] },
      media15s,
    )
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("clip-0-15000")
  })

  // Test para cobertura 100%: media inválida
  it("descarta media inválida", () => {
    const cut = [{ startMs: 0, endMs: 15_000, title: "a", score: 1 }]
    expect(validateCuts(cut, { durationMs: 0 })).toEqual([])
    expect(validateCuts(cut, { durationMs: -1 })).toEqual([])
    expect(validateCuts(cut, { durationMs: Number.NaN })).toEqual([])
    expect(validateCuts(cut, { durationMs: Number.POSITIVE_INFINITY })).toEqual([])
    expect(validateCuts(cut, { durationMs: 14_999 })).toEqual([])
  })

  it("no lanza si un getter de la entrada lanza", () => {
    const hostile = {
      get cuts(): unknown[] {
        throw new Error("boom")
      },
    }
    expect(validateCuts(hostile, media15s)).toEqual([])

    const hostileCut = {
      startMs: 0,
      get endMs(): number {
        throw new Error("boom")
      },
      title: "a",
      score: 1,
    }
    expect(validateCuts([hostileCut], media15s)).toEqual([])
  })

  it("cuenta code points, no unidades UTF-16, en el título", () => {
    const title80 = "😀".repeat(80)
    expect(title80.length).toBe(160)
    const accepted = validateCuts(
      [{ startMs: 0, endMs: 15_000, title: title80, score: 1 }],
      media15s,
    )
    expect(accepted).toHaveLength(1)

    const title81 = "😀".repeat(81)
    expect(
      validateCuts([{ startMs: 0, endMs: 15_000, title: title81, score: 1 }], media15s),
    ).toEqual([])
  })

  it("mantiene la invariante de no solape aunque un corte choque con varios aceptados", () => {
    const cuts = [
      { startMs: 0, endMs: 150_000, title: "a", score: 0.9 },
      { startMs: 160_000, endMs: 180_000, title: "b", score: 0.5 },
      { startMs: 140_000, endMs: 165_000, title: "c", score: 0.95 },
    ]
    const result = validateCuts(cuts, { durationMs: 200_000 })
    expect(result).toHaveLength(1)
    expect(result[0].score).toBe(0.95)
    for (let i = 1; i < result.length; i++) {
      expect(result[i].startMs).toBeGreaterThanOrEqual(result[i - 1].endMs)
    }
  })

  it("colapsa dos cortes con IoU exactamente 0.8 porque se solapan", () => {
    const cuts = [
      { startMs: 0, endMs: 20_000, title: "a", score: 0.4 },
      { startMs: 4_000, endMs: 24_000, title: "b", score: 0.9 },
    ]
    const result = validateCuts(cuts, media315s)
    expect(result).toHaveLength(1)
    expect(result[0].score).toBe(0.9)
  })

  // Test para cobertura 100%: solapes con score mayor
  it("remueve solapes conservando mayor score", () => {
    const cuts = [
      { startMs: 0, endMs: 25_000, title: "lower-score", score: 0.5 },
      { startMs: 5_000, endMs: 20_000, title: "higher-score", score: 0.8 },
    ]
    const result = validateCuts(cuts, media315s)
    // The higher-score cut should be kept, the lower-score should be removed
    expect(result).toHaveLength(1)
    expect(result[0].score).toBe(0.8)
  })

  // Test para cobertura 100%: títulos con caracteres de borde
  it("maneja títulos con espacios en blanco al recortar", () => {
    const result = validateCuts(
      [{ startMs: 0, endMs: 15_000, title: "  hello  ", score: 1 }],
      media15s,
    )
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe("hello")
  })
})
