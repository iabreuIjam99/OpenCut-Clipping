import { Elysia } from "elysia"
import { describe, expect, it, vi } from "vitest"
import { createAnalyzeRoute } from "./analyze.route"
import { asRecord } from "./providers/groq"
import type { AiBinding } from "./providers/workers-ai"
import type { RuntimeSecurity } from "./transcribe.route"

const SALT = "test-salt"
const IP = "203.0.113.7"

const emptyAi: AiBinding = {
  run: async (): Promise<unknown> => ({}),
}

function secureApp(
  options: {
    security?: Partial<RuntimeSecurity>
    // `null` es un valor significativo: simula un despliegue sin binding `AI`.
    ai?: AiBinding | null
  } = {},
) {
  const security = options.security ?? {}
  return new Elysia().use(
    createAnalyzeRoute({
      security: {
        turnstile: async () => true,
        quota: { store: { consume: async (): Promise<number> => 1 }, limit: 20 },
        ipHashSalt: SALT,
        required: true,
        ...security,
      },
      ai: options.ai === undefined ? emptyAi : options.ai,
    }),
  )
}

describe("analyze.route - integration with app.handle", () => {
  // 200 con respuesta válida del LLM (2 cortes)
  it("200 con respuesta válida del LLM (2 cortes)", async () => {
    const twoCutsAi: AiBinding = {
      run: async (): Promise<unknown> => ({
        response: JSON.stringify({
          cuts: [
            { startMs: 0, endMs: 15_000, title: "hola mundo", score: 0.9 },
            { startMs: 30_000, endMs: 45_000, title: "adios mundo", score: 0.8 },
          ],
        }),
      }),
    }
    const app = secureApp({ ai: twoCutsAi })
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [
          { startMs: 0, endMs: 15000, text: "hola mundo" },
          { startMs: 30000, endMs: 45000, text: "adios mundo" },
        ],
        brief: "titulo de prueba",
        durationMs: 600000,
      }),
    })

    const response = await app.handle(request)
    expect(response.status).toBe(200)

    const payload: unknown = await response.json()
    expect(payload).toEqual({
      cuts: [
        { id: "clip-0-15000", startMs: 0, endMs: 15_000, title: "hola mundo", score: 0.9 },
        {
          id: "clip-30000-45000",
          startMs: 30_000,
          endMs: 45_000,
          title: "adios mundo",
          score: 0.8,
        },
      ],
    })
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // 200 {cuts: []} cuando el binding lanza
  it("200 {cuts: []} cuando el binding lanza", async () => {
    const throwingAi: AiBinding = {
      run: async (): Promise<unknown> => {
        throw new Error("API error")
      },
    }
    const app = secureApp({ ai: throwingAi })
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola mundo" }],
        brief: "prueba",
        durationMs: 600000,
      }),
    })

    const response = await app.handle(request)
    expect(response.status).toBe(200)
    const payload: unknown = await response.json()
    expect(payload).toEqual({ cuts: [] })
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // 200 {cuts: []} cuando el binding lanza síncronamente
  it("200 {cuts: []} cuando el binding lanza síncronamente", async () => {
    const throwingAi: AiBinding = {
      run: (): Promise<unknown> => {
        throw new Error("boom")
      },
    }
    const app = secureApp({ ai: throwingAi })
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola mundo" }],
        brief: "prueba",
        durationMs: 600000,
      }),
    })

    const response = await app.handle(request)
    expect(response.status).toBe(200)
    const payload: unknown = await response.json()
    expect(payload).toEqual({ cuts: [] })
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // 400: cuerpo no JSON, { cuts: "x" }, null, []
  it('400: cuerpo no JSON, { cuts: "x" }, null, []', async () => {
    // Test content-type no JSON
    const request1 = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: { "content-type": "text/plain", "cf-connecting-ip": IP },
      body: "not json",
    })
    const app1 = secureApp()
    let response = await app1.handle(request1)
    expect(response.status).toBe(400)

    // Test body { cuts: "x" }
    const request2 = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": IP },
      body: JSON.stringify({ cuts: "x" }),
    })
    const app2 = secureApp()
    response = await app2.handle(request2)
    expect(response.status).toBe(400)

    // Test body [] (empty array)
    const request3 = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": IP },
      body: JSON.stringify([]),
    })
    const app3 = secureApp()
    response = await app3.handle(request3)
    expect(response.status).toBe(400)

    // Test body missing segments
    const request4 = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": IP },
      body: JSON.stringify({ brief: "prueba", durationMs: 600000 }),
    })
    const app4 = secureApp()
    response = await app4.handle(request4)
    expect(response.status).toBe(400)
  })

  // cortes inválidos del LLM se descartan y los válidos se conservan
  it("cortes inválidos del LLM se descartan y los válidos se conservan", async () => {
    const mixedAi: AiBinding = {
      run: async (): Promise<unknown> => ({
        response: JSON.stringify({
          cuts: [
            { startMs: 0, endMs: 15_000, title: "Valid clip", score: 0.9 },
            { startMs: 0, endMs: 5_000, title: "<script>alert('xss')</script>", score: 0.5 },
          ],
        }),
      }),
    }
    const app = secureApp({ ai: mixedAi })
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola" }],
        brief: "titulo de prueba",
        durationMs: 600000,
      }),
    })

    const response = await app.handle(request)
    expect(response.status).toBe(200)

    const payload: unknown = await response.json()
    expect(payload).toEqual({
      cuts: [{ id: "clip-0-15000", startMs: 0, endMs: 15_000, title: "Valid clip", score: 0.9 }],
    })
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // 401 con Turnstile false
  it("401 con Turnstile false", async () => {
    const app = secureApp({ security: { turnstile: async () => false } })
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "bad-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola" }],
        brief: "prueba",
        durationMs: 600000,
      }),
    })

    const response = await app.handle(request)
    expect(response.status).toBe(401)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // 429 con cuota agotada
  it("429 con cuota agotada", async () => {
    const app = secureApp({
      security: { quota: { store: { consume: async (): Promise<number> => 21 }, limit: 20 } },
    })
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola" }],
        brief: "prueba",
        durationMs: 600000,
      }),
    })

    const response = await app.handle(request)
    expect(response.status).toBe(429)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // 400: cuerpo no JSON
  it("400: cuerpo no JSON", async () => {
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: { "content-type": "text/plain", "cf-connecting-ip": IP },
      body: "raw body",
    })
    const app = secureApp()
    const response = await app.handle(request)
    expect(response.status).toBe(400)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // 400: brief vacío
  it("400: brief vacío", async () => {
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": IP },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola" }],
        brief: "",
        durationMs: 600000,
      }),
    })
    const app = secureApp()
    const response = await app.handle(request)
    expect(response.status).toBe(400)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // 400: brief de 501 code points
  it("400: brief de 501 code points", async () => {
    const longBrief = "a".repeat(501)
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": IP },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola" }],
        brief: longBrief,
        durationMs: 600000,
      }),
    })
    const app = secureApp()
    const response = await app.handle(request)
    expect(response.status).toBe(400)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // 400: content-type distinto de JSON
  it("400: content-type distinto de JSON", async () => {
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: { "content-type": "multipart/form-data", "cf-connecting-ip": IP },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola" }],
        brief: "prueba",
        durationMs: 600000,
      }),
    })
    const app = secureApp()
    const response = await app.handle(request)
    expect(response.status).toBe(400)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // required false: ruta funciona sin Turnstile/quota, pero exige AI binding
  it("required false: ruta funciona sin Turnstile ni cuota, pero exige AI binding", async () => {
    const oneCutAi: AiBinding = {
      run: async (): Promise<unknown> => ({
        response: JSON.stringify({
          cuts: [{ startMs: 0, endMs: 15_000, title: "Test", score: 0.8 }],
        }),
      }),
    }
    const app = secureApp({
      security: { turnstile: null, quota: null, ipHashSalt: null, required: false },
      ai: oneCutAi,
    })
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola" }],
        brief: "prueba",
        durationMs: 600000,
      }),
    })

    const response = await app.handle(request)
    expect(response.status).toBe(200)

    const payload: unknown = await response.json()
    expect(payload).toEqual({
      cuts: [{ id: "clip-0-15000", startMs: 0, endMs: 15_000, title: "Test", score: 0.8 }],
    })
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // 429 sin cf-connecting-ip
  it("429 sin cf-connecting-ip", async () => {
    const app = secureApp()
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        // Sin cf-connecting-ip
      },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola" }],
        brief: "prueba",
        durationMs: 600000,
      }),
    })

    const response = await app.handle(request)
    expect(response.status).toBe(429)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // Cache-Control: no-store en todas las respuestas
  it("Cache-Control: no-store en todas las respuestas", async () => {
    const app = secureApp()
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola" }],
        brief: "prueba",
        durationMs: 600000,
      }),
    })

    const response = await app.handle(request)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // 502 por configuración de seguridad incompleta (fail-closed)
  it("502 con Turnstile ausente cuando required es true", async () => {
    const app = secureApp({ security: { turnstile: null } })
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": IP },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola" }],
        brief: "prueba",
        durationMs: 600000,
      }),
    })
    const response = await app.handle(request)
    expect(response.status).toBe(502)
  })

  it("502 con cuota ausente cuando required es true", async () => {
    const app = secureApp({ security: { quota: null } })
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola" }],
        brief: "prueba",
        durationMs: 600000,
      }),
    })
    const response = await app.handle(request)
    expect(response.status).toBe(502)
  })

  it("502 con ipHashSalt ausente cuando required es true", async () => {
    const app = secureApp({ security: { ipHashSalt: null } })
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola" }],
        brief: "prueba",
        durationMs: 600000,
      }),
    })
    const response = await app.handle(request)
    expect(response.status).toBe(502)
  })

  it("502 con cuota configurada y sin salt (required false)", async () => {
    const app = secureApp({
      security: { required: false, turnstile: null, ipHashSalt: null },
    })
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": IP },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola" }],
        brief: "prueba",
        durationMs: 600000,
      }),
    })
    const response = await app.handle(request)
    expect(response.status).toBe(502)
  })

  it("502 cuando hashIp rechaza la IP", async () => {
    const app = secureApp({
      security: { required: false, turnstile: null },
    })
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "1".repeat(200),
      },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola" }],
        brief: "prueba",
        durationMs: 600000,
      }),
    })
    const response = await app.handle(request)
    expect(response.status).toBe(502)
  })

  // 502 con binding AI ausente
  it("502 con binding AI ausente", async () => {
    const app = secureApp({
      security: {
        turnstile: async () => true,
        quota: { store: { consume: async (): Promise<number> => 1 }, limit: 20 },
        ipHashSalt: SALT,
        required: true,
      },
      ai: null,
    })
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola" }],
        brief: "prueba",
        durationMs: 600000,
      }),
    })

    const response = await app.handle(request)
    expect(response.status).toBe(502)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // 502 cuando el almacén de cuota lanza (fallo de D1, no del cliente)
  it("502 cuando el almacén de cuota lanza", async () => {
    const app = secureApp({
      security: {
        quota: {
          store: {
            consume: async (): Promise<number> => {
              throw new Error("D1 down")
            },
          },
          limit: 20,
        },
      },
    })
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola" }],
        brief: "prueba",
        durationMs: 600000,
      }),
    })

    const response = await app.handle(request)
    expect(response.status).toBe(502)
  })

  // 400 cuando ningún segmento sobrevive a la normalización
  it("400 cuando ningún segmento es válido", async () => {
    const app = secureApp()
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [
          { startMs: 10_000, endMs: 5_000, text: "invertido" },
          { startMs: -1, endMs: 5_000, text: "negativo" },
          { startMs: 0, endMs: 1_000, text: 42 },
        ],
        brief: "prueba",
        durationMs: 600000,
      }),
    })

    const response = await app.handle(request)
    expect(response.status).toBe(400)
  })

  // 400 cuando durationMs excede el máximo
  it("400 cuando durationMs excede el máximo", async () => {
    const app = secureApp()
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola" }],
        brief: "prueba",
        durationMs: 86_400_001,
      }),
    })

    const response = await app.handle(request)
    expect(response.status).toBe(400)
  })

  // 400 con brief no string
  it("400 con brief no string", async () => {
    const app = secureApp()
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola" }],
        brief: 42,
        durationMs: 600000,
      }),
    })

    const response = await app.handle(request)
    expect(response.status).toBe(400)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // 200 {cuts: []} cuando el LLM devuelve cuts no array
  it("200 {cuts: []} cuando el LLM devuelve cuts no array", async () => {
    const cutsNotArrayAi: AiBinding = {
      run: async (): Promise<unknown> => ({
        response: JSON.stringify({
          cuts: "x",
        }),
      }),
    }
    const app = secureApp({ ai: cutsNotArrayAi })
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola" }],
        brief: "prueba",
        durationMs: 600000,
      }),
    })

    const response = await app.handle(request)
    expect(response.status).toBe(200)

    const payload: unknown = await response.json()
    expect(payload).toEqual({ cuts: [] })
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // 200 {cuts: []} cuando el LLM devuelve un objeto sin cuts
  it("200 {cuts: []} cuando el LLM devuelve un objeto sin cuts", async () => {
    const noCutsAi: AiBinding = {
      run: async (): Promise<unknown> => ({
        response: JSON.stringify({
          foo: "bar",
        }),
      }),
    }
    const app = secureApp({ ai: noCutsAi })
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola" }],
        brief: "prueba",
        durationMs: 600000,
      }),
    })

    const response = await app.handle(request)
    expect(response.status).toBe(200)

    const payload: unknown = await response.json()
    expect(payload).toEqual({ cuts: [] })
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // 200 {cuts: []} cuando el LLM devuelve prosa sin JSON
  it("200 {cuts: []} cuando el LLM devuelve prosa sin JSON", async () => {
    const proseAi: AiBinding = {
      run: async (): Promise<unknown> => ({
        response: "lo siento, no puedo analizar esto",
      }),
    }
    const app = secureApp({ ai: proseAi })
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15000, text: "hola" }],
        brief: "prueba",
        durationMs: 600000,
      }),
    })

    const response = await app.handle(request)
    expect(response.status).toBe(200)

    const payload: unknown = await response.json()
    expect(payload).toEqual({ cuts: [] })
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // --- Contrato de errores: estado, código, Cache-Control y binding intacto ---

  type ErrorCase = {
    readonly name: string
    readonly headers?: Record<string, string>
    readonly body?: string
    readonly security?: Partial<RuntimeSecurity>
    readonly ai?: AiBinding | null
    readonly status: number
    readonly code: string
  }

  const validBody = JSON.stringify({
    segments: [{ startMs: 0, endMs: 15_000, text: "hola" }],
    brief: "prueba",
    durationMs: 600_000,
  })

  const errorCases: ErrorCase[] = [
    {
      name: "content-type no JSON",
      headers: { "content-type": "text/plain" },
      body: "no importa",
      status: 400,
      code: "INVALID_REQUEST",
    },
    { name: "cuerpo no JSON", body: "{no es json", status: 400, code: "INVALID_REQUEST" },
    { name: "cuerpo null", body: "null", status: 400, code: "INVALID_REQUEST" },
    { name: "cuerpo array", body: "[]", status: 400, code: "INVALID_REQUEST" },
    {
      name: "segments ausente",
      body: JSON.stringify({ brief: "prueba", durationMs: 600_000 }),
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "segments vacio",
      body: JSON.stringify({ segments: [], brief: "prueba", durationMs: 600_000 }),
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "segments no array",
      body: JSON.stringify({ segments: "x", brief: "prueba", durationMs: 600_000 }),
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "segments con 5001 elementos",
      body: JSON.stringify({
        segments: Array.from({ length: 5_001 }, (_, i) => ({
          startMs: i,
          endMs: i + 1,
          text: "x",
        })),
        brief: "prueba",
        durationMs: 600_000,
      }),
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "durationMs cero",
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15_000, text: "hola" }],
        brief: "prueba",
        durationMs: 0,
      }),
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "durationMs fraccionario",
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15_000, text: "hola" }],
        brief: "prueba",
        durationMs: 600_000.5,
      }),
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "durationMs fuera de rango",
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15_000, text: "hola" }],
        brief: "prueba",
        durationMs: 86_400_001,
      }),
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "brief vacio",
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15_000, text: "hola" }],
        brief: "   ",
        durationMs: 600_000,
      }),
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "brief de 501 code points",
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15_000, text: "hola" }],
        brief: "x".repeat(501),
        durationMs: 600_000,
      }),
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "brief solo con caracteres de control",
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15_000, text: "hola" }],
        brief: "\u0001\u0002",
        durationMs: 600_000,
      }),
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "segmentos que colapsan al redondear",
      body: JSON.stringify({
        segments: [{ startMs: 0.6, endMs: 0.8, text: "hola" }],
        brief: "prueba",
        durationMs: 600_000,
      }),
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "segmento con texto en blanco",
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15_000, text: "   " }],
        brief: "prueba",
        durationMs: 600_000,
      }),
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "segments con un elemento que no es objeto",
      body: JSON.stringify({ segments: ["x"], brief: "prueba", durationMs: 600_000 }),
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "segmento al que le faltan campos",
      body: JSON.stringify({
        segments: [{ startMs: 0, text: "hola" }],
        brief: "prueba",
        durationMs: 600_000,
      }),
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "segmento con startMs no numerico",
      body: JSON.stringify({
        segments: [{ startMs: "0", endMs: 15_000, text: "hola" }],
        brief: "prueba",
        durationMs: 600_000,
      }),
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "segmento con endMs no numerico",
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: "15000", text: "hola" }],
        brief: "prueba",
        durationMs: 600_000,
      }),
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "segmento con text no string",
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15_000, text: 42 }],
        brief: "prueba",
        durationMs: 600_000,
      }),
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      name: "Turnstile invalido",
      security: { turnstile: async () => false },
      status: 401,
      code: "UNAUTHORIZED",
    },
    {
      name: "cuota agotada",
      security: { quota: { store: { consume: async (): Promise<number> => 21 }, limit: 20 } },
      status: 429,
      code: "QUOTA_EXCEEDED",
    },
    { name: "binding AI ausente", ai: null, status: 502, code: "UPSTREAM_ERROR" },
  ]

  it.each(errorCases)("$name -> $status $code, sin invocar el binding", async (testCase) => {
    const runMock = vi.fn(async (_model: string, _input: unknown): Promise<unknown> => ({}))
    const spyAi: AiBinding = { run: runMock }
    const app = secureApp({
      security: testCase.security ?? {},
      ai: testCase.ai === undefined ? spyAi : testCase.ai,
    })
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
        ...testCase.headers,
      },
      body: testCase.body ?? validBody,
    })

    const response = await app.handle(request)
    expect(response.status).toBe(testCase.status)
    expect(response.headers.get("Cache-Control")).toBe("no-store")

    const payload: unknown = await response.json()
    const error = asRecord(payload) ? payload.error : undefined
    expect(asRecord(error) ? error.code : undefined).toBe(testCase.code)
    expect(runMock).not.toHaveBeenCalled()
  })

  it("200 acepta exactamente 5000 segmentos", async () => {
    const app = secureApp()
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: Array.from({ length: 5_000 }, (_, i) => ({
          startMs: i,
          endMs: i + 1,
          text: "x",
        })),
        brief: "prueba",
        durationMs: 600_000,
      }),
    })

    const response = await app.handle(request)
    expect(response.status).toBe(200)
    const payload: unknown = await response.json()
    expect(payload).toEqual({ cuts: [] })
  })

  it("200 acepta un segmento que termina justo en durationMs", async () => {
    const app = secureApp()
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [{ startMs: 585_000, endMs: 600_000, text: "hola" }],
        brief: "prueba",
        durationMs: 600_000,
      }),
    })

    const response = await app.handle(request)
    expect(response.status).toBe(200)
  })

  it("el modelo recibe el brief recortado y el segmento formateado", async () => {
    const runMock = vi.fn(
      async (_model: string, _input: unknown): Promise<unknown> => ({
        response: '{"cuts":[]}',
      }),
    )
    const captureAi: AiBinding = { run: runMock }
    const app = secureApp({ ai: captureAi })
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15_000, text: "hola mundo" }],
        brief: "  recortes de producto  ",
        durationMs: 600_000,
      }),
    })

    const response = await app.handle(request)
    expect(response.status).toBe(200)
    expect(runMock).toHaveBeenCalledTimes(1)

    const call = runMock.mock.calls[0]
    expect(call?.[0]).toBe("@cf/openai/gpt-oss-20b")

    const payload = call?.[1]
    const messages = asRecord(payload) ? payload.messages : undefined
    expect(Array.isArray(messages)).toBe(true)
    if (!Array.isArray(messages)) throw new Error("messages no es un array")

    const userMessage = messages[1]
    const content = asRecord(userMessage) ? userMessage.content : undefined
    expect(typeof content).toBe("string")
    if (typeof content !== "string") throw new Error("content no es un string")

    expect(content).toContain("<brief>recortes de producto</brief>")
    expect(content).toContain("[0-15000] hola mundo")
    expect(content).not.toContain("  recortes de producto  ")
  })

  it("400 rechaza un brief de 1 MB sin recorrerlo entero", async () => {
    const runMock = vi.fn(async (_model: string, _input: unknown): Promise<unknown> => ({}))
    const app = secureApp({ ai: { run: runMock } })
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15_000, text: "hola" }],
        brief: "x".repeat(1_000_000),
        durationMs: 600_000,
      }),
    })

    const response = await app.handle(request)
    expect(response.status).toBe(400)
    expect(runMock).not.toHaveBeenCalled()
  })

  it("recorta el texto de un segmento gigante antes de construir el prompt", async () => {
    const runMock = vi.fn(
      async (_model: string, _input: unknown): Promise<unknown> => ({
        response: '{"cuts":[]}',
      }),
    )
    const app = secureApp({ ai: { run: runMock } })
    const request = new Request("http://localhost/v1/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "turnstile-token",
        "cf-connecting-ip": IP,
      },
      body: JSON.stringify({
        segments: [{ startMs: 0, endMs: 15_000, text: "y".repeat(100_000) }],
        brief: "prueba",
        durationMs: 600_000,
      }),
    })

    const response = await app.handle(request)
    expect(response.status).toBe(200)

    const call = runMock.mock.calls[0]
    const payload = call?.[1]
    const messages = asRecord(payload) ? payload.messages : undefined
    if (!Array.isArray(messages)) throw new Error("messages no es un array")
    const userMessage = messages[1]
    const content = asRecord(userMessage) ? userMessage.content : undefined
    if (typeof content !== "string") throw new Error("content no es un string")

    // 24 000 de transcript como máximo, más las etiquetas del prompt.
    expect(content.length).toBeLessThanOrEqual(24_400)
    expect(content).toContain("[0-15000] yyy")
  })
})
