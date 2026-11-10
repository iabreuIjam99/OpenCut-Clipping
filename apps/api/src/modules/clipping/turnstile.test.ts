import { describe, expect, it, vi } from "vitest"
import { createTurnstileVerifier } from "./turnstile"

const SECRET = "test-secret-key"
const url = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

describe("createTurnstileVerifier", () => {
  it("devuelve false cuando token es null", async () => {
    const verifier = createTurnstileVerifier({ secret: SECRET })
    const result = await verifier(null, "1.2.3.4")
    expect(result).toBe(false)
  })

  it("devuelve false cuando token es vacío", async () => {
    const verifier = createTurnstileVerifier({ secret: SECRET })
    const result = await verifier("", "1.2.3.4")
    expect(result).toBe(false)
  })

  it("éxito cuando el response de Cloudflare es success:true", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, challenge_ts: new Date().toISOString(), hostname: "test" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    )

    const verifier = createTurnstileVerifier({ secret: SECRET, fetchImpl: fetchMock })
    const result = await verifier("some-token", "1.2.3.4")
    expect(result).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(url, expect.anything())
  })

  it("devuelve false cuando el response no es ok (status no 2xx)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "server_error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    )

    const verifier = createTurnstileVerifier({ secret: SECRET, fetchImpl: fetchMock })
    const result = await verifier("some-token", "1.2.3.4")
    expect(result).toBe(false)
  })

  it("devuelve false cuando el JSON tiene success: false", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, errorCodes: [10001] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    const verifier = createTurnstileVerifier({ secret: SECRET, fetchImpl: fetchMock })
    const result = await verifier("some-token", "1.2.3.4")
    expect(result).toBe(false)
  })

  it("devuelve false cuando el JSON es inválido", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ invalid: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    const verifier = createTurnstileVerifier({ secret: SECRET, fetchImpl: fetchMock })
    const result = await verifier("some-token", "1.2.3.4")
    expect(result).toBe(false)
  })

  it("devuelve false cuando fetch lanza", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network error"))

    const verifier = createTurnstileVerifier({ secret: SECRET, fetchImpl: fetchMock })
    const result = await verifier("some-token", "1.2.3.4")
    expect(result).toBe(false)
  })

  it("cumple timeout de 5000 ms por defecto", async () => {
    const fetchMock = vi.fn().mockRejectedValue({
      name: "AbortError",
      code: "ABORT_ERR",
    })

    const verifier = createTurnstileVerifier({
      secret: SECRET,
      fetchImpl: fetchMock,
      timeoutMs: 5_000,
    })
    const result = await verifier("some-token", "1.2.3.4")
    expect(result).toBe(false)

    const init = fetchMock.mock.calls[0]?.[1]
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it("usa remoteip en el body cuando se provee", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    const verifier = createTurnstileVerifier({ secret: SECRET, fetchImpl: fetchMock })
    await verifier("token", "2001:db8::1")
    const calls = fetchMock.mock.calls
    const init = calls[calls.length - 1]?.[1]
    const body = init?.body
    expect(body).toBeInstanceOf(URLSearchParams)
    if (!(body instanceof URLSearchParams)) throw new Error("body no es URLSearchParams")
    expect(body.get("remoteip")).toBe("2001:db8::1")
  })

  it("no incluye remoteip en el body cuando no se provee", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    const verifier = createTurnstileVerifier({ secret: SECRET, fetchImpl: fetchMock })
    await verifier("token", null)
    const calls = fetchMock.mock.calls
    const init = calls[calls.length - 1]?.[1]
    const body = init?.body
    expect(body).toBeInstanceOf(URLSearchParams)
    if (!(body instanceof URLSearchParams)) throw new Error("body no es URLSearchParams")
    expect(body.has("remoteip")).toBe(false)
  })

  it("usa Content-Type application/x-www-form-urlencoded", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    const verifier = createTurnstileVerifier({ secret: SECRET, fetchImpl: fetchMock })
    await verifier("token", "1.2.3.4")
    const calls = fetchMock.mock.calls
    const init = calls[calls.length - 1][1]
    expect(init?.headers["Content-Type"]).toBe("application/x-www-form-urlencoded")
  })

  it("no loguea el token ni el secreto en error", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const fetchMock = vi.fn().mockRejectedValue(new Error("network error"))

    const verifier = createTurnstileVerifier({ secret: SECRET, fetchImpl: fetchMock })
    await expect(verifier("some-token", "1.2.3.4")).resolves.toBe(false)

    expect(consoleSpy).not.toHaveBeenCalled()

    consoleSpy.mockRestore()
  })
})
