import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { ClientOnly } from "./client-only"

describe("ClientOnly", () => {
  it("SSR: renderiza null (sin placeholder) en el servidor", () => {
    const html = renderToString(
      <ClientOnly>
        <span>Editor client-only</span>
      </ClientOnly>,
    )

    expect(html).toBe("")
    expect(html).not.toContain("Editor client-only")
  })

  it("cliente: null en el primer render y los children tras el efecto de montaje", async () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      root.render(
        <ClientOnly>
          <span>Editor client-only</span>
        </ClientOnly>,
      )

      // Primer render (equivalente a la hidratación): null, sin children
      expect(container.querySelector("span")).toBeNull()
      expect(container.innerHTML).toBe("")

      // Tras el efecto de montaje los children aparecen
      await act(async () => {})
      expect(container.querySelector("span")).not.toBeNull()
      expect(container.textContent).toBe("Editor client-only")
    } finally {
      root.unmount()
      document.body.removeChild(container)
    }
  })
})
