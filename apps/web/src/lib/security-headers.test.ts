import { describe, expect, it } from "vitest"

import {
  buildContentSecurityPolicy,
  generateNonce,
  injectNonceIntoHtml,
  withSecurityHeaders,
} from "./security-headers"

describe("buildContentSecurityPolicy", () => {
  it("producción sin nonce: script-src 'self' y nunca 'unsafe-inline'", () => {
    const csp = buildContentSecurityPolicy({ dev: false })
    const scriptDirective = csp.split("; ").find((d) => d.startsWith("script-src"))
    expect(scriptDirective).toBe("script-src 'self'")
    expect(scriptDirective).not.toContain("'unsafe-inline'")
    expect(csp).not.toMatch(/nonce-/)
  })

  it("producción con nonce: 'nonce-<valor>' en script-src", () => {
    const csp = buildContentSecurityPolicy({ dev: false, nonce: "abc123" })
    expect(csp).toContain("script-src 'self' 'nonce-abc123'")
  })

  it("dev con nonce: 'nonce-<valor>' en script-src y ws en connect-src", () => {
    const csp = buildContentSecurityPolicy({ dev: true, nonce: "abc123" })
    expect(csp).toContain("script-src 'self' 'nonce-abc123'")
    expect(csp).toContain("connect-src 'self' ws: wss:")
  })

  it("dev: connect-src permite ws: wss: para HMR de Vite", () => {
    const csp = buildContentSecurityPolicy({ dev: true })
    expect(csp).toContain("connect-src 'self' ws: wss:")
  })

  it("producción: connect-src solo 'self'", () => {
    const csp = buildContentSecurityPolicy({ dev: false })
    expect(csp).toContain("connect-src 'self'")
    expect(csp).not.toContain("ws:")
  })

  it("incluye orígenes de Google Fonts y prohíbe objetos/iframes", () => {
    const csp = buildContentSecurityPolicy({ dev: false })
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com")
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'self'")
  })
})

describe("withSecurityHeaders", () => {
  it("añade Content-Security-Policy sin mutar la respuesta original", () => {
    const original = new Response("hola", {
      status: 200,
      headers: { "content-type": "text/plain" },
    })
    const csp = buildContentSecurityPolicy({ dev: false })
    const secured = withSecurityHeaders(original, csp)

    expect(secured.headers.get("Content-Security-Policy")).toBe(csp)
    expect(secured.status).toBe(200)
    expect(secured).not.toBe(original)
    expect(original.headers.get("Content-Security-Policy")).toBeNull()
  })

  it("añade CSP también a respuestas no-HTML (JSON)", () => {
    const original = new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    })
    const csp = buildContentSecurityPolicy({ dev: false })
    const secured = withSecurityHeaders(original, csp)

    expect(secured.headers.get("Content-Security-Policy")).toBe(csp)
    expect(secured.headers.get("content-type")).toBe("application/json")
  })
})

describe("generateNonce", () => {
  it("devuelve base64 de 16 bytes (128 bits), nunca hex", () => {
    const nonce = generateNonce()

    // base64 de 16 bytes: 24 caracteres (incluye padding '==' cuando 16 mod 3 = 1)
    expect(nonce).toMatch(/^[A-Za-z0-9+/=]{24}$/)
    expect(nonce).not.toMatch(/^[0-9a-f]{32}$/) // no es hex de 32 chars

    // Decodifica a exactamente 16 bytes
    const decoded = new Uint8Array(
      atob(nonce)
        .split("")
        .map((c) => c.charCodeAt(0)),
    )
    expect(decoded.length).toBe(16)
  })

  it("no devuelve el mismo valor dos veces (aleatorio)", () => {
    expect(generateNonce()).not.toBe(generateNonce())
  })
})

describe("injectNonceIntoHtml", () => {
  const base = (html: string) =>
    new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })

  it("añade nonce a los <script> en línea (sin src)", async () => {
    const secured = await injectNonceIntoHtml(
      base(
        '<script data-tsr-stream-part="">(self.$R=self.$R||{})["tsr"]=[];</script><script>document.currentScript.remove()</script>',
      ),
      "abc-123",
    )

    const body = await secured.text()
    expect(body).toContain('<script data-tsr-stream-part="" nonce="abc-123">')
    expect(body).toContain('<script nonce="abc-123">document.currentScript.remove()</script>')
    expect(secured.headers.get("Content-Security-Policy")).toBeNull()
  })

  it("no toca scripts externos (src) ni scripts con nonce", async () => {
    const secured = await injectNonceIntoHtml(
      base(
        '<script src="/assets/index.js"></script><script nonce="existing">x</script><script>inline</script>',
      ),
      "nonce-value",
    )

    const body = await secured.text()
    expect(body).toContain('<script src="/assets/index.js"></script>')
    expect(body).toContain('<script nonce="existing">x</script>')
    expect(body).toContain('<script nonce="nonce-value">inline</script>')
  })

  it("respuestas no-HTML pasan sin cambios", async () => {
    const original = new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    })
    const secured = await injectNonceIntoHtml(original, "abc-123")
    expect(secured).toBe(original)
  })

  it("sin scripts en línea devuelve la misma respuesta", async () => {
    const original = base("<p>hola</p>")
    const secured = await injectNonceIntoHtml(original, "abc-123")
    expect(secured).toBe(original)
  })

  it("no trata un literal <script dentro de una cadena JSON como etiqueta", async () => {
    const json = JSON.stringify({ snippet: "<script>alert('x')</script>" })
    const secured = await injectNonceIntoHtml(
      base(`<script type="application/json">${json}</script><script>inline</script>`),
      "nonce-value",
    )

    const body = await secured.text()
    // El envoltorio <script type="application/json"> SÍ recibe nonce (no tiene src)
    expect(body).toContain(`<script type="application/json" nonce="nonce-value">`)
    // El literal "<script" dentro del JSON va precedido de '"', así que no se toca
    expect(body).toContain('"snippet":"<script>alert(\'x\')</script>"')
    // El script en línea final recibe nonce una sola vez
    expect(body).toContain('<script nonce="nonce-value">inline</script>')
    // Dos scripts reciben nonce: el envoltorio y el final; el literal del JSON, no
    expect(body.match(/nonce="nonce-value"/g)).toHaveLength(2)
  })
})
