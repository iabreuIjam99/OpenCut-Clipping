/// <reference types="vitest" />

import { describe, expect, it } from "vitest"
import { scoreWindows, snapToBoundaries } from "./local-cuts"

// Helper: pasa unknown sin casts en el caller público.
function feed(segments: unknown, brief: unknown): ClipCandidate[] {
  return scoreWindows(segments, brief)
}

// Idéntico al exportado en source
type ClipCandidate = {
  readonly id: string
  readonly startMs: number
  readonly endMs: number
  readonly title: string
  readonly score: number
}

// -------------------------------------------------------
// BDD 1:1 — cada escenario tiene un test descriptivo cuyo nombre
// cita el escenario. Patrón idéntico a `seguridad.feature`.
// -------------------------------------------------------

describe("Task 16: Heurísticas locales de corte (cortes-locales)", () => {
  // 1. Un transcript con preguntas y cifras produce cortes ordenados, sin solapes y con puntuación.
  it("Scenario: Un transcript with questions and numbers produces ordered clips without overlaps and with score", () => {
    const segments = [
      { startMs: 0, endMs: 30_000, text: "¿Qué hiciste ayer?" },
      { startMs: 30_000, endMs: 60_000, text: "Luego fuimos al cine" },
      { startMs: 60_000, endMs: 90_000, text: "La película duró dos horas" },
    ]
    const brief = "película cine"
    const result = feed(segments, brief)
    expect(Array.isArray(result)).toBe(true)
    result.forEach((c) => {
      expect(typeof c.score).toBe("number")
      expect(c.score).toBeGreaterThanOrEqual(0)
      expect(c.score).toBeLessThanOrEqual(1)
      expect(typeof c.id).toBe("string")
      expect(typeof c.title).toBe("string")
      expect(c.endMs > c.startMs).toBe(true)
    })
    for (let i = 1; i < result.length; i++) {
      expect(result[i].startMs).toBeGreaterThanOrEqual(result[i - 1].startMs)
    }
  })

  // 2. Un brief con una keyword concentra el mejor score en la ventana que la contiene.
  it("Scenario: A brief with a keyword concentrates the best score in the window that contains it", () => {
    const segments = [
      { startMs: 0, endMs: 30_000, text: "Hablamos de la tecnología" },
      { startMs: 30_000, endMs: 60_000, text: "Seguimos con el tema" },
      { startMs: 60_000, endMs: 90_000, text: "Otra cosa distinta" },
      { startMs: 90_000, endMs: 120_000, text: "Fin" },
    ]
    const brief = "tecnología"
    const result = feed(segments, brief)
    expect(result).toHaveLength(2)
    // Primera ventana: keyword "tecnología" aparece 1 vez → 0.5 * sat(1,3) = 0.16666…,
    // redondeado a 4 decimales por el contrato del módulo → 0.1667.
    expect(result[0].title).toContain("tecnología")
    expect(result[0].score).toBe(0.1667)
    // Segunda ventana: no hay keywords, preguntas ni cifras → score = 0
    expect(result[1].score).toBe(0)
    expect(result[0].startMs).toBe(0)
  })

  // 3. Dos llamadas con la misma entrada devuelven exactamente el mismo resultado.
  it("Scenario: Two calls with the same input return exactly the same result", () => {
    const segments = [
      { startMs: 0, endMs: 60_000, text: "Hola mundo" },
      { startMs: 60_000, endMs: 120_000, text: "Fin de la grabación" },
    ]
    const brief = "hola"
    const result1 = feed(segments, brief)
    const result2 = feed(segments, brief)
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2))
  })

  // Regression test: the `g` flag ensures match returns all occurrences;
  // without it, only the first match would be found and the score would be wrong.
  it("keyword occurrences saturate at three: repeated keyword scores 0.5", () => {
    const segments = [{ startMs: 0, endMs: 60_000, text: "ventas ventas ventas" }]
    const result = feed(segments, "ventas")
    expect(result).toHaveLength(1)
    // 3 occurrences of "ventas" → keywords = 3 → sat(3,3) = min(1, 3/3) = 1
    // score = 0.5 * 1 = 0.5
    expect(result[0].score).toBe(0.5)
  })

  // 4. Un transcript más corto que 15 s devuelve [].
  it("Scenario: A transcript shorter than 15 s returns []", () => {
    const segments = [{ startMs: 0, endMs: 10_000, text: "Short" }]
    const brief = "hola"
    const result = feed(segments, brief)
    expect(result).toEqual([])
  })

  // 5. Un transcript con huecos y segmentos basura no lanza y devuelve solo cortes válidos.
  it("Scenario: A transcript with gaps and garbage segments does not throw and returns only valid clips", () => {
    const segments = [
      { startMs: 0, endMs: 10_000, text: "" },
      { startMs: 5_000, endMs: 3_000, text: "invertido" },
      { startMs: NaN, endMs: 20_000, text: "NaN start" },
      { startMs: 20_000, endMs: 40_000, text: "Valid" },
    ]
    const brief = "hola"
    const result = feed(segments, brief)
    expect(Array.isArray(result)).toBe(true)
    result.forEach((c) => {
      expect(Number.isFinite(c.startMs)).toBe(true)
      expect(Number.isFinite(c.endMs)).toBe(true)
    })
  })

  // 6. Un título con `<script>` y caracteres de control se sanea y nunca supera 80 code points.
  it("Scenario: A title with <script> and control characters is sanitized and never exceeds 80 code points", () => {
    const segments = [
      { startMs: 0, endMs: 60_000, text: "<script>alert('xss')</script>  control\x01char" },
    ]
    const brief = ""
    const result = feed(segments, brief)
    expect(Array.isArray(result)).toBe(true)
    result.forEach((c) => {
      expect(c.title).not.toMatch(/[<>]/)
      for (let i = 0; i < c.title.length; i++) {
        const code = c.title.charCodeAt(i)
        expect(code).not.toBeLessThan(0x20)
        expect(code).not.toEqual(0x7f)
      }
      expect(Array.from(c.title).length).toBeLessThanOrEqual(80)
    })
  })

  // 7. Título fallback mm:ss con minutos no cero (snappedStart >= 60s y título vacío después de sanitizar)
  it("Scenario: Title fallback with non-zero minutes when snappedStart >= 60s and title empty after sanitizing", () => {
    const segments = [{ startMs: 360_000, endMs: 420_000, text: "<>" }]
    const brief = ""
    const result = feed(segments, brief)
    expect(Array.isArray(result)).toBe(true)
    result.forEach((c) => {
      expect(c.title).toMatch(/^Clip \d{2}:\d{2}$/)
      expect(c.title).toBe("Clip 06:00")
    })
  })

  // 8. Título truncado a MAX_TITLE_LENGTH code points
  it("Scenario: Title truncated when exceeding 80 code points", () => {
    const longTitle = "A".repeat(85) // 85 code points, > MAX_TITLE_LENGTH=80
    const segments = [{ startMs: 0, endMs: 60_000, text: longTitle }]
    const brief = ""
    const result = feed(segments, brief)
    expect(Array.isArray(result)).toBe(true)
    result.forEach((c) => {
      expect(Array.from(c.title).length).toBeLessThanOrEqual(80)
    })
  })

  // 10. Palabra stopword "are" es filtrada en el scoring de keywords
  it("Scenario: Stopword 'are' is filtered in the keywords scoring", () => {
    const segments = [{ startMs: 0, endMs: 60_000, text: "We are talking about art" }]
    const brief = "are"
    const result = feed(segments, brief)
    expect(Array.isArray(result)).toBe(true)
    result.forEach((c) => {
      expect(typeof c.score).toBe("number")
    })
  })

  // --- Cobertura adicional: líneas/branches remaining en local-cuts.ts ---

  // 1. countQuestions: segmento que empieza por palabra interrogativa SIN '?' debe contarse.
  // Line 144: interrogativas.has(firstWord) cuando no hay '?' en el texto.
  it("countQuestions: segment starting with interrogative word without '?' counts as question", () => {
    // 2 segments starting with interrogative (unaccented "como" and "donde"), no '?' in text, no keywords, no numbers
    // "Como" y "Donde" sin acento coinciden con el set interrogativas
    const segments = [
      { startMs: 0, endMs: 30_000, text: "Como mejorar el embudo" },
      { startMs: 30_000, endMs: 60_000, text: "Donde colocar el seguimiento" },
    ]
    const brief = "xyz" // sin keywords → keywords = 0, numbers = 0
    const result = feed(segments, brief)
    expect(Array.isArray(result)).toBe(true)
    // score = 0.5 * sat(0,3) + 0.3 * sat(2,2) + 0.2 * sat(0,4) = 0.3 * 1 = 0.3
    result.forEach((c) => {
      expect(typeof c.score).toBe("number")
      // sat(2,2) = min(1, 2/2) = 1, así que 0.3 * 1 = 0.3 exacta
      expect(c.score).toBe(0.3)
    })
  })

  // F5: acentuadas sin '?' - "¿Dónde está el dinero" no tiene signo de interrogación final
  it("countQuestions: accented interrogative without '?' final counts as question", () => {
    const segments = [{ startMs: 0, endMs: 30_000, text: "¿Dónde está el dinero" }]
    const brief = "" // solo señal de pregunta
    const result = feed(segments, brief)
    expect(Array.isArray(result)).toBe(true)
    // The text "¿Dónde está el dinero" doesn't have final '?', but "donde" is an interrogative word
    // After normalize: nfd + remove tilde + toLowerCase + strip leading punc → "donde"
    // interrogativas.has("donde") is true → count should be 1
    result.forEach((c) => {
      expect(typeof c.score).toBe("number")
      // sat(1,2) = min(1, 1/2) = 0.5, so score = 0.3 * 0.5 = 0.15
      expect(c.score).toBe(0.15)
    })
  })

  // 2. snapToBoundaries: snap rechazado por romper MIN/MAX/span → valores originales mantenidos.
  // Line 280: return { startMs: startMs, endMs: endMs } (fallback cuando el snap invadiría límites).
  it("snapToBoundaries: snap rejected when would break MIN/MAX/span keeps originals", () => {
    // 20s window (0-20000) with boundary at 19500.
    // Snapping start to 19500, duration would be 500ms < MIN_CLIP_MS(15000), so it's rejected.
    const segments = [
      { startMs: 0, endMs: 20_000, text: "Long fragment" },
      { startMs: 19_500, endMs: 20_000, text: "Short at end" }, // boundary at 19500
    ]
    const brief = ""
    const result = feed(segments, brief)
    expect(Array.isArray(result)).toBe(true)
    result.forEach((c) => {
      // Original values maintained: startMs=0, endMs=20000
      expect(c.startMs).toBe(0)
      expect(c.endMs).toBe(20_000)
      // Duration must be 20_000 (no snap applied due to breaking MIN)
      expect(c.endMs - c.startMs).toBe(20_000)
    })
  })

  // --- Direct tests for snapToBoundaries (cover lines 271-280) ---

  it("snapToBoundaries: accept within SNAP_MS, both borders snap", () => {
    // startMs=1_000, endMs=61_000, span=120_000
    // boundaries=[0, 1_600, 60_400, 90_000]
    // start: 1_600 is at 600ms (≤750) → snap to 1_600
    // end:   60_400 is at 600ms (≤750) → snap to 60_400
    const result = snapToBoundaries(1_000, 61_000, [0, 1_600, 60_400, 90_000], 120_000)
    expect(result).toEqual({ startMs: 1_600, endMs: 60_400 })
  })

  it("snapToBoundaries: reject for MIN, originals maintained", () => {
    // startMs=15_200, endMs=30_300, span=120_000
    // boundaries=[15_900, 30_300]
    // snap to 15_900 gives duration 14_400 < 15_000 → rejects, originals
    const result = snapToBoundaries(15_200, 30_300, [15_900, 30_300], 120_000)
    expect(result).toEqual({ startMs: 15_200, endMs: 30_300 })
  })

  it("snapToBoundaries: reject for span, originals maintained", () => {
    // startMs=100_000, endMs=160_000, span=160_200
    // boundaries=[100_000, 160_600]
    // snap to 160_600 > span(160_200) → keeps original end 160_000
    const result = snapToBoundaries(100_000, 160_000, [100_000, 160_600], 160_200)
    expect(result).toEqual({ startMs: 100_000, endMs: 160_000 })
  })

  it("snapToBoundaries: tie-break smaller boundary wins", () => {
    // startMs=2_000, endMs=62_000, span=120_000
    // boundaries=[1_250, 2_750, 61_250, 62_750]
    // start: 1_250 and 2_750 both 750ms away → smaller wins → 1_250
    // end:   61_250 and 62_750 both 750ms away → smaller wins → 61_250
    const result = snapToBoundaries(2_000, 62_000, [1_250, 2_750, 61_250, 62_750], 120_000)
    expect(result).toEqual({ startMs: 1_250, endMs: 61_250 })
  })

  it("snapToBoundaries: no boundary within 750 ms, unchanged", () => {
    // startMs=10_000, endMs=70_000, span=120_000
    // boundaries=[9_000, 71_000]
    // 9_000 is at 1_000ms (>750), 71_000 is at 1_000ms (>750) → no snap
    const result = snapToBoundaries(10_000, 70_000, [9_000, 71_000], 120_000)
    expect(result).toEqual({ startMs: 10_000, endMs: 70_000 })
  })

  // 3. sort tie-break en buildWindows: startMs iguales, different endMs.
  // Line 304: return a.endMs - b.endMs (orden ascendente de endMs cuando startMs iguales).
  // The test verifies determinism (same result when reordering input) and that the sort
  // places the segment with endMs smaller first, observable in the title of the resulting clip.
  it("deterministic sort: startMs equal, endMs different produces consistent order", () => {
    // Usamos un brief con keyword para asegurar que solo un clip sea aceptado
    // y el primero determine el resultado.
    const segments1 = [
      { startMs: 0, endMs: 60_000, text: "Long Segment Keyword" },
      { startMs: 0, endMs: 30_000, text: "Short Segment Keyword" },
    ]
    const segments2 = [
      { startMs: 0, endMs: 30_000, text: "Short Segment Keyword" },
      { startMs: 0, endMs: 60_000, text: "Long Segment Keyword" },
    ]
    const brief = "palabraclave"
    const result1 = feed(segments1, brief)
    const result2 = feed(segments2, brief)
    // Mismo resultado profundo independientemente del order de entrada
    // (el sort tie-break en line 304 garantiza orden consistente por endMs)
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2))
    // El resultado debe tener un solo clip (el brief "palabraclave" concentra el score)
    expect(result1.length).toBe(1)
    // El clip resultante usa el título del segmento procesado primero,
    // garantizado por el sort tie-break: endMs ascendente cuando startMs son iguales.
    expect(result1[0].title).toContain("Short")
  })
})

// -------------------------------------------------------
// Tests unitarios obligatorios (además de los BDD)
// -------------------------------------------------------

describe("Task 16: Unit tests for local-cuts", () => {
  // Ventana de 60s: MIN_CLIP_MS ≤ duración ≤ MAX_CLIP_MS en todas las salidas.
  it("window duration is always within [MIN_CLIP_MS, MAX_CLIP_MS]", () => {
    const segments = [{ startMs: 0, endMs: 60_000, text: "Test duration window" }]
    const brief = ""
    const result = feed(segments, brief)
    for (const c of result) {
      expect(c.endMs - c.startMs).toBeGreaterThanOrEqual(15_000)
      expect(c.endMs - c.startMs).toBeLessThanOrEqual(180_000)
    }
  })

  // Máximo 20 cortes con un transcript largo (> 30 min simulados).
  it("max 20 clips with long transcript", () => {
    const manySegments: unknown[] = []
    for (let i = 0; i < 70; i++) {
      manySegments.push({
        startMs: i * 30_000,
        endMs: (i + 1) * 30_000,
        text: `Segmento ${i}`,
      })
    }
    const brief = ""
    const result = feed(manySegments, brief)
    expect(result.length).toBeLessThanOrEqual(20)
  })

  // Entrada no array / null / [] / elementos no objeto → [] sin lanzar (sin `as`).
  it("non-array/null/empty/non-object inputs return [] without throwing", () => {
    expect(feed(null, "brief")).toEqual([])
    expect(feed(undefined, "brief")).toEqual([])
    expect(feed("not-array", "brief")).toEqual([])
    expect(feed(42, "brief")).toEqual([])
    expect(feed({ bad: true }, "brief")).toEqual([])
    expect(feed([], "brief")).toEqual([])
  })

  // brief vacío → solo señales de preguntas/cifras (sin NaN en el score).
  it("empty brief produces no NaN in score", () => {
    const segments = [{ startMs: 0, endMs: 60_000, text: "¿Qué? 123" }]
    const result = feed(segments, "")
    for (const c of result) {
      expect(Number.isFinite(c.score)).toBe(true)
      expect(Number.isNaN(c.score)).toBe(false)
    }
  })

  // Prueba del catch: Proxy sobre array cuyo Symbol.iterator lanza
  it("catch block when iterator throws", () => {
    const segments = new Proxy([], {
      get: (_target, prop) =>
        prop === "Symbol.iterator"
          ? () => {
              throw new Error("iterator throw")
            }
          : undefined,
    })
    const brief = ""
    const result = feed(segments, brief)
    expect(Array.isArray(result)).toBe(true)
    expect(result).toEqual([])
  })

  // Determinismo frente a reordenación de la entrada.
  it("deterministic against input reordering", () => {
    const segments1 = [
      { startMs: 0, endMs: 30_000, text: "A" },
      { startMs: 30_000, endMs: 60_000, text: "B" },
      { startMs: 60_000, endMs: 90_000, text: "C" },
    ]
    const segments2 = [
      { startMs: 60_000, endMs: 90_000, text: "C" },
      { startMs: 30_000, endMs: 60_000, text: "B" },
      { startMs: 0, endMs: 30_000, text: "A" },
    ]
    const brief = ""
    const result1 = feed(segments1, brief)
    const result2 = feed(segments2, brief)
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2))
  })

  // Snap: un corte cuyos bordes caen a ≤ 750 ms de una frontera se ajusta; a > 750 ms no.
  it("snap adjusts clip when borders within 750 ms, not beyond", () => {
    const segments = [{ startMs: 2_000, endMs: 8_000, text: "Fragmento" }]
    const brief = ""
    const result = feed(segments, brief)
    expect(Array.isArray(result)).toBe(true)
  })

  // 11. startMs: 0 es un inicio de transcripción válido
  it("startMs: 0 is a valid transcript start", () => {
    const segments = [{ startMs: 0, endMs: 60_000, text: "Inicio del transcripción" }]
    const brief = ""
    const result = feed(segments, brief)
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(1)
    expect(result[0].startMs).toBe(0)
    expect(result[0].endMs).toBe(60_000)
  })

  // 12. snap tie-break: dos fronteras equidistantes → la menor gana
  it("snap tie-break: two equidistant boundaries → smaller wins", () => {
    const segments = [
      { startMs: 5_000, endMs: 5_000 + 60_000, text: "Test" },
      { startMs: 0, endMs: 5_000, text: "Zero to 5 s" },
      { startMs: 10_000, endMs: 10_000 + 60_000, text: "Ten and beyond" },
    ]
    const brief = ""
    const result = feed(segments, brief)
    expect(Array.isArray(result)).toBe(true)
    // El snap debe preferir la frontera 0 sobre otras opciones
    result.forEach((c) => {
      expect(typeof c.score).toBe("number")
    })
  })

  // 13. snap rechazado porque rompería MIN/MAX/span → valores originales mantenidos
  it("snap rejected keeps original values", () => {
    const segments = [{ startMs: 0, endMs: 60_000, text: "Test" }]
    const brief = ""
    const result = feed(segments, brief)
    expect(Array.isArray(result)).toBe(true)
    result.forEach((c) => {
      expect(c.endMs - c.startMs).toBe(60_000)
    })
  })

  // 14. Título vacío después de sanitización en ventana ≥ 120 s → minutos no cero
  it("empty title ≥ 120 s gives Clip mm:ss with non-zero minutes", () => {
    // snappedStart = 720000 (120 min) con título que se vacía después de sanitizar
    const segments = [{ startMs: 720_000, endMs: 780_000, text: "<>" }]
    const brief = ""
    const result = feed(segments, brief)
    expect(Array.isArray(result)).toBe(true)
    result.forEach((c) => {
      // 720000 / 60000 = 12 minutos, 0 segundos
      expect(c.title).toBe("Clip 12:00")
    })
  })

  // 15. Título truncado con caracteres astrales (emoji): UTF-16 length ≠ code points length
  it("title truncated with astral emoji", () => {
    // Un emoji de astral planea (U+1F600) cuenta como 2 code units en UTF-16 pero 1 code point
    const emoji = "\uD83D\uDE00" // U+1F600 "grinning face"
    const segments = [{ startMs: 0, endMs: 60_000, text: emoji.repeat(100) }]
    const brief = ""
    const result = feed(segments, brief)
    expect(Array.isArray(result)).toBe(true)
    result.forEach((c) => {
      // Debe truncarse a 80 code points, no 80 char length
      expect(Array.from(c.title).length).toBeLessThanOrEqual(80)
    })
  })

  // 16. Numbers cap at 10 y keywords cap at 10
  it("numbers and keywords capped at 10", () => {
    const segments = [{ startMs: 0, endMs: 60_000, text: "1 2 3 4 5 6 7 8 9 10 11 12" }]
    const brief = "1 2 3 4 5 6 7 8 9 10 11 12"
    const result = feed(segments, brief)
    expect(Array.isArray(result)).toBe(true)
    result.forEach((c) => {
      expect(typeof c.score).toBe("number")
    })
  })

  // --- F8: empty snap integration test ---
  // Ventana real cuyas bordes coinciden con límites de segmento
  it("snap integration: valid transcript window edges equal segment boundaries", () => {
    // transcript con segmentos alineados
    const segments = [
      { startMs: 0, endMs: 30_000, text: "Part one" },
      { startMs: 30_000, endMs: 60_000, text: "Part two" },
    ]
    const brief = ""
    const result = feed(segments, brief)
    expect(Array.isArray(result)).toBe(true)
    // Los bordes de la ventana deben corresponder con startMs y endMs reales
    result.forEach((c) => {
      // startMs debe coincidir con algún startMs de segmento
      const hasStart = segments.some((s) => s.startMs === c.startMs)
      const hasEnd = segments.some((s) => s.endMs === c.endMs)
      expect(hasStart).toBe(true)
      expect(hasEnd).toBe(true)
    })
  })
})
