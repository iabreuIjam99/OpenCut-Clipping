import { describe, expect, it } from "vitest"

import { cn } from "./utils"

describe("cn", () => {
  it("concatenates independent class names", () => {
    expect(cn("p-2", "text-red-500")).toBe("p-2 text-red-500")
  })

  it("resolves conflicting Tailwind classes keeping the last one", () => {
    expect(cn("p-2", "p-4")).toBe("p-4")
    expect(cn("px-2", "px-4")).toBe("px-4")
  })

  it("returns an empty string when called without arguments", () => {
    expect(cn()).toBe("")
  })
})
