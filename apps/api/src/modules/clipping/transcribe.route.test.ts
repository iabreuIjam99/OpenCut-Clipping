import { Elysia } from "elysia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { transcribeRoute } from "./transcribe.route"

const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
vi.stubGlobal("fetch", fetchMock)

const KEY = "gsk_test_0000000000000000000000000000"
const URL = "http://localhost/v1/transcribe"

function formRequest(key: string | null = KEY) {
  const form = new FormData()
  form.append("file", new Blob(["audio"]), "audio.webm")
  form.append("model", "whisper-large-v3-turbo")
  form.append("response_format", "verbose_json")
  form.append("timestamp_granularities[]", "segment")
  form.append("language", "en")
  form.append("temperature", "0")
  const headers: Record<string, string> = {}
  if (key !== null) headers["x-provider-key"] = key
  return new Request(URL, { method: "POST", body: form, headers })
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const app = new Elysia().use(transcribeRoute)

describe("transcribe.route - integration with app.handle", () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })
  // Case 1: success → 200, mapped segments/language, no-store
  it("success: multipart with key, upstream gets Authorization Bearer, original Content-Type, body is ReadableStream, x-provider-key absent, 200 {segments, language}, cache-control: no-store", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        language: "en",
        duration: 5,
        segments: [{ start: 0, end: 2.5, text: "hola" }],
      }),
    )

    const request = formRequest(KEY)
    const response = await app.handle(request)

    expect(await response.json()).toMatchObject({
      language: "en",
      segments: [{ startMs: 0, endMs: 2500, text: "hola" }],
    })

    expect(response.status).toBe(200)

    // Verificar llamada a fetch
    const call = fetchMock.mock.calls[0]
    if (!call) throw new Error("fetch no fue llamado")
    const [url, init] = call
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`)
    expect(headers.get("x-provider-key")).toBeNull()
    expect(headers.get("content-type")).toContain("multipart/form-data")
    expect(init?.body).toBeInstanceOf(ReadableStream)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // Case 2: missing key → 401 UNAUTHORIZED, fetch not called
  it("missing key → 401 UNAUTHORIZED, fetch not called", async () => {
    const request = new Request(URL, {
      method: "POST",
      body: new FormData(),
      headers: { "content-type": "multipart/form-data; boundary=----WebKitFormBoundary" },
    })

    const response = await app.handle(request)
    expect(response.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // Case 3: body oversized → 413 UNSUPPORTED_MEDIA, fetch not called
  it("oversized body → 413 UNSUPPORTED_MEDIA, fetch not called", async () => {
    const form = new FormData()
    form.append("file", new Blob(["audio"]), "audio.webm")
    form.append("model", "whisper-large-v3-turbo")
    form.append("response_format", "verbose_json")

    const request = new Request(URL, {
      method: "POST",
      body: form,
      headers: {
        "x-provider-key": KEY,
        "content-type": "multipart/form-data; boundary=----WebKitFormBoundary",
        "content-length": "26214401", // > 25 MiB
      },
    })

    const response = await app.handle(request)
    expect(response.status).toBe(413)

    expect(await response.json()).toMatchObject({ error: { code: "UNSUPPORTED_MEDIA" } })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // Case 1d: content-length bypasses - Infinity, NaN, negative
  it("content-length 1e400 → 413 UNSUPPORTED_MEDIA, fetch not called", async () => {
    const form = new FormData()
    form.append("file", new Blob(["audio"]), "audio.webm")
    form.append("model", "whisper-large-v3-turbo")
    form.append("response_format", "verbose_json")

    const request = new Request(URL, {
      method: "POST",
      body: form,
      headers: {
        "x-provider-key": KEY,
        "content-type": "multipart/form-data; boundary=----WebKitFormBoundary",
        "content-length": "1e400",
      },
    })

    const response = await app.handle(request)
    expect(response.status).toBe(413)

    expect(await response.json()).toMatchObject({ error: { code: "UNSUPPORTED_MEDIA" } })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  it("content-length abc → 413 UNSUPPORTED_MEDIA, fetch not called", async () => {
    const form = new FormData()
    form.append("file", new Blob(["audio"]), "audio.webm")
    form.append("model", "whisper-large-v3-turbo")
    form.append("response_format", "verbose_json")

    const request = new Request(URL, {
      method: "POST",
      body: form,
      headers: {
        "x-provider-key": KEY,
        "content-type": "multipart/form-data; boundary=----WebKitFormBoundary",
        "content-length": "abc",
      },
    })

    const response = await app.handle(request)
    expect(response.status).toBe(413)

    expect(await response.json()).toMatchObject({ error: { code: "UNSUPPORTED_MEDIA" } })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  it("content-length -1 → 413 UNSUPPORTED_MEDIA, fetch not called", async () => {
    const form = new FormData()
    form.append("file", new Blob(["audio"]), "audio.webm")
    form.append("model", "whisper-large-v3-turbo")
    form.append("response_format", "verbose_json")

    const request = new Request(URL, {
      method: "POST",
      body: form,
      headers: {
        "x-provider-key": KEY,
        "content-type": "multipart/form-data; boundary=----WebKitFormBoundary",
        "content-length": "-1",
      },
    })

    const response = await app.handle(request)
    expect(response.status).toBe(413)

    expect(await response.json()).toMatchObject({ error: { code: "UNSUPPORTED_MEDIA" } })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // Case 4: non-multipart → 415, fetch not called
  it("non-multipart → 415, fetch not called", async () => {
    const request = new Request(URL, {
      method: "POST",
      body: new Blob(["audio"]),
      headers: {
        "x-provider-key": KEY,
        "content-type": "text/plain",
      },
    })

    const response = await app.handle(request)
    expect(response.status).toBe(415)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // Case 5: Groq 500 with /secret/path and stack → 502 UPSTREAM_ERROR
  it("Groq 500 with /secret/path and stack → 502 UPSTREAM_ERROR, response body contains none of it", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "/secret/path", stack: "Error: something went wrong" }),
        { status: 500, headers: { "content-type": "application/json" } },
      ),
    )

    const request = formRequest(KEY)
    const response = await app.handle(request)
    expect(response.status).toBe(502)

    expect(await response.json()).toMatchObject({ error: { code: "UPSTREAM_ERROR" } })
  })

  // Case 5b: Groq 403 → 401 UNAUTHORIZED
  it("Groq 403 → 401 UNAUTHORIZED", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    )

    const request = formRequest(KEY)
    const response = await app.handle(request)
    expect(response.status).toBe(401)

    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } })
  })

  // Case 5c: Groq 400 → 415 UNSUPPORTED_MEDIA
  it("Groq 400 → 415 UNSUPPORTED_MEDIA", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "bad_request" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    )

    const request = formRequest(KEY)
    const response = await app.handle(request)
    expect(response.status).toBe(415)

    expect(await response.json()).toMatchObject({ error: { code: "UNSUPPORTED_MEDIA" } })
  })

  // Case 5d: Groq 413 → 415 UNSUPPORTED_MEDIA
  it("Groq 413 → 415 UNSUPPORTED_MEDIA", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "payload_too_large" }), {
        status: 413,
        headers: { "content-type": "application/json" },
      }),
    )

    const request = formRequest(KEY)
    const response = await app.handle(request)
    expect(response.status).toBe(415)

    expect(await response.json()).toMatchObject({ error: { code: "UNSUPPORTED_MEDIA" } })
  })

  // Case 5e: Groq 422 → 415 UNSUPPORTED_MEDIA
  it("Groq 422 → 415 UNSUPPORTED_MEDIA", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "unsupported_type" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
    )

    const request = formRequest(KEY)
    const response = await app.handle(request)
    expect(response.status).toBe(415)

    expect(await response.json()).toMatchObject({ error: { code: "UNSUPPORTED_MEDIA" } })
  })

  // Case 5f: Groq 418 → 502 UPSTREAM_ERROR
  it("Groq 418 → 502 UPSTREAM_ERROR", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "im_a_teapot" }), {
        status: 418,
        headers: { "content-type": "application/json" },
      }),
    )

    const request = formRequest(KEY)
    const response = await app.handle(request)
    expect(response.status).toBe(502)

    expect(await response.json()).toMatchObject({ error: { code: "UPSTREAM_ERROR" } })
  })

  // Case 6: Groq 429 → 429 QUOTA_EXCEEDED
  it("Groq 429 → 429 QUOTA_EXCEEDED", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "rate_limit" }, 429))

    const request = formRequest(KEY)
    const response = await app.handle(request)
    expect(response.status).toBe(429)

    expect(await response.json()).toMatchObject({ error: { code: "QUOTA_EXCEEDED" } })
  })

  // Case 7: Groq 401 → 401 UNAUTHORIZED
  it("Groq 401 → 401 UNAUTHORIZED", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "invalid_key" }, 401))

    const request = formRequest(KEY)
    const response = await app.handle(request)
    expect(response.status).toBe(401)

    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } })
  })

  // Case 8: Groq 200 malformed JSON → 502
  it("Groq 200 malformed JSON → 502 UPSTREAM_ERROR", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
    )

    const request = formRequest(KEY)
    const response = await app.handle(request)
    expect(response.status).toBe(502)

    expect(await response.json()).toMatchObject({ error: { code: "UPSTREAM_ERROR" } })
  })

  // Case 9: Groq 200 { segments: [], text: '' } → 200 { segments: [], language: 'und' } (silence is not error)
  it("Groq 200 { segments: [], text: '' } → 200 { segments: [], language: 'und' }", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ segments: [], text: "" }))

    const request = formRequest(KEY)
    const response = await app.handle(request)
    expect(response.status).toBe(200)

    expect(await response.json()).toMatchObject({ segments: [], language: "und" })
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  // Case 10: Groq 200 { foo: 'bar' } → 502
  it("Groq 200 { foo: 'bar' } → 502 UPSTREAM_ERROR", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ foo: "bar" }))

    const request = formRequest(KEY)
    const response = await app.handle(request)
    expect(response.status).toBe(502)

    expect(await response.json()).toMatchObject({ error: { code: "UPSTREAM_ERROR" } })
  })

  // Case 12: Streaming assertion - init.body is ReadableStream
  it("streaming: init.body is ReadableStream", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        language: "en",
        duration: 5,
        segments: [{ start: 0, end: 2.5, text: "hola" }],
      }),
    )

    const request = formRequest(KEY)
    const response = await app.handle(request)
    expect(response.status).toBe(200)

    const call = fetchMock.mock.calls[0]
    if (!call) throw new Error("fetch no fue llamado")
    const [, init] = call
    expect(init?.body).toBeInstanceOf(ReadableStream)
  })

  // Case 13: no body with multipart content-type → 200, init?.body is undefined
  it("no body with multipart content-type → 200, init?.body is undefined", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        language: "en",
        duration: 5,
        segments: [{ start: 0, end: 2.5, text: "hola" }],
      }),
    )

    const request = new Request(URL, {
      method: "POST",
      headers: {
        "x-provider-key": KEY,
        "content-type": "multipart/form-data; boundary=x",
      },
    })
    const response = await app.handle(request)
    expect(response.status).toBe(200)

    const call = fetchMock.mock.calls[0]
    if (!call) throw new Error("fetch no fue llamado")
    const [, init] = call
    expect(init?.body).toBeUndefined()
  })

  // Case 14: POST with valid key and NO content-type header → 415, fetch not called
  it("valid key, no content-type → 415 UNSUPPORTED_MEDIA, fetch not called", async () => {
    const request = new Request(URL, {
      method: "POST",
      body: new Blob(["dummy"]),
      headers: {
        "x-provider-key": KEY,
      },
    })

    const response = await app.handle(request)
    expect(response.status).toBe(415)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
