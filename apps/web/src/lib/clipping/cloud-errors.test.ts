import { describe, expect, it } from "vitest"
import type { CloudErrorCode } from "./cloud-errors"
import { CloudTranscriptionError, fromHttpResponse, toCloudFailure } from "./cloud-errors"

const PROVIDER_KEY = "sk-proveedor-clave-secreta-12345"

function expectFailure(
  input: unknown,
  code: CloudErrorCode,
  fallbackToLocal: boolean,
  message: string,
): void {
  const result = toCloudFailure(input)
  expect(result).toMatchObject({ code, fallbackToLocal, message })
}

describe("toCloudFailure por status HTTP", () => {
  it("Scenario: Un 429 del proxy propone el modo local (fallbackToLocal: true); un 401 no", () => {
    expectFailure(429, "QUOTA_EXCEEDED", true, "Cuota agotada; puedes usar el modo local.")
    expectFailure(401, "UNAUTHORIZED", false, "No autorizado.")
  })

  it("401 → UNAUTHORIZED sin fallback a local", () => {
    expectFailure(401, "UNAUTHORIZED", false, "No autorizado.")
  })

  it("413 y 415 → UNSUPPORTED_MEDIA sin fallback a local", () => {
    expectFailure(413, "UNSUPPORTED_MEDIA", false, "Formato no soportado.")
    expectFailure(415, "UNSUPPORTED_MEDIA", false, "Formato no soportado.")
  })

  it("429 → QUOTA_EXCEEDED con fallback a local", () => {
    expectFailure(429, "QUOTA_EXCEEDED", true, "Cuota agotada; puedes usar el modo local.")
  })

  it("502 → UPSTREAM_ERROR con fallback a local", () => {
    expectFailure(
      502,
      "UPSTREAM_ERROR",
      true,
      "El servicio no está disponible; puedes usar el modo local.",
    )
  })

  it("0 → NETWORK con fallback a local", () => {
    expectFailure(0, "NETWORK", true, "Sin conexión; puedes usar el modo local.")
  })

  it("status desconocido → UPSTREAM_ERROR con fallback a local", () => {
    expectFailure(
      500,
      "UPSTREAM_ERROR",
      true,
      "El servicio no está disponible; puedes usar el modo local.",
    )
    expectFailure(
      400,
      "UPSTREAM_ERROR",
      true,
      "El servicio no está disponible; puedes usar el modo local.",
    )
    expectFailure(
      NaN,
      "UPSTREAM_ERROR",
      true,
      "El servicio no está disponible; puedes usar el modo local.",
    )
  })
})

describe("toCloudFailure por payload del proxy", () => {
  it("mapea los cinco códigos conocidos", () => {
    expectFailure({ error: { code: "UNAUTHORIZED" } }, "UNAUTHORIZED", false, "No autorizado.")
    expectFailure(
      { error: { code: "UNSUPPORTED_MEDIA" } },
      "UNSUPPORTED_MEDIA",
      false,
      "Formato no soportado.",
    )
    expectFailure(
      { error: { code: "QUOTA_EXCEEDED" } },
      "QUOTA_EXCEEDED",
      true,
      "Cuota agotada; puedes usar el modo local.",
    )
    expectFailure(
      { error: { code: "UPSTREAM_ERROR" } },
      "UPSTREAM_ERROR",
      true,
      "El servicio no está disponible; puedes usar el modo local.",
    )
    expectFailure(
      { error: { code: "NETWORK" } },
      "NETWORK",
      true,
      "Sin conexión; puedes usar el modo local.",
    )
  })

  it("códigos de payload desconocidos → UPSTREAM_ERROR", () => {
    expectFailure(
      { error: { code: "INVALID_KEY" } },
      "UPSTREAM_ERROR",
      true,
      "El servicio no está disponible; puedes usar el modo local.",
    )
    expectFailure(
      { error: { code: "otro" } },
      "UPSTREAM_ERROR",
      true,
      "El servicio no está disponible; puedes usar el modo local.",
    )
  })
})

describe("toCloudFailure con basura sin lanzar", () => {
  it("null → NETWORK", () => {
    expectFailure(null, "NETWORK", true, "Sin conexión; puedes usar el modo local.")
  })

  it.each([
    ["array", ["a"]],
    ["string", "cadena-basura"],
    ["número", 123],
    ["objeto vacío", {}],
    ["error no objeto", { error: "no-es-objeto" }],
    ["error sin código", { error: {} }],
  ])("entrada %s → UPSTREAM_ERROR", (_label: string, input: unknown) => {
    expectFailure(
      input,
      "UPSTREAM_ERROR",
      true,
      "El servicio no está disponible; puedes usar el modo local.",
    )
  })
})

describe("toCloudFailure no filtra información sensible", () => {
  it("el mensaje no contiene stack, rutas ni la clave del proveedor", () => {
    const input = {
      error: {
        code: "UPSTREAM_ERROR",
        stack: "Error at fetch\n    at /secret/route/proxy",
        providerKey: PROVIDER_KEY,
        url: "https://api.internal/transcribe?key=sk-secret",
      },
    }
    const result = toCloudFailure(input)
    expect(result.code).toBe("UPSTREAM_ERROR")
    expect(result.message).toBe("El servicio no está disponible; puedes usar el modo local.")
    expect(result.message).not.toContain("stack")
    expect(result.message).not.toContain("/secret")
    expect(result.message).not.toContain(PROVIDER_KEY)
    expect(result.message).not.toContain("api.internal")
  })
})

describe("toCloudFailure es puro", () => {
  it("misma entrada produce misma salida y no muta la entrada", () => {
    const input: Record<string, unknown> = { error: { code: "429" } }
    const first = toCloudFailure(input)
    const second = toCloudFailure(input)
    expect(second).toEqual(first)
    expect(input).toEqual({ error: { code: "429" } })
    expect(first.code).toBe("UPSTREAM_ERROR")
  })
})

describe("CloudTranscriptionError", () => {
  it("expone code, fallbackToLocal y un mensaje genérico en español", () => {
    const error = new CloudTranscriptionError(
      "QUOTA_EXCEEDED",
      true,
      "Cuota agotada; puedes usar el modo local.",
    )

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("CloudTranscriptionError")
    expect(error.code).toBe("QUOTA_EXCEEDED")
    expect(error.fallbackToLocal).toBe(true)
    expect(error.message).toBe("Cuota agotada; puedes usar el modo local.")
  })
})

describe("fromHttpResponse", () => {
  it("delega en toCloudFailure sin filtrar el payload", () => {
    const conPayload = fromHttpResponse(429, {
      error: { code: "UNAUTHORIZED" },
      stack: "at /secret",
      providerKey: PROVIDER_KEY,
    })
    expect(conPayload).toMatchObject({ code: "QUOTA_EXCEEDED", fallbackToLocal: true })
    expect(conPayload.message).toBe("Cuota agotada; puedes usar el modo local.")

    const sinPayload = fromHttpResponse(401)
    expect(sinPayload).toMatchObject({ code: "UNAUTHORIZED", fallbackToLocal: false })
    expect(sinPayload.message).toBe("No autorizado.")
  })
})
