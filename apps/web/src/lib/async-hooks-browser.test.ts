import { describe, expect, it } from "vitest"
import { AsyncLocalStorage } from "../async-hooks-browser"

describe("AsyncLocalStorage", () => {
  describe("getStore", () => {
    it("returns undefined outside of run()", () => {
      const store = new AsyncLocalStorage()
      expect(store.getStore()).toBeUndefined()
    })
  })

  describe("run", () => {
    it("exposes the store inside the callback and restores it on exit", () => {
      const store = new AsyncLocalStorage()
      const result = store.run(42, () => {
        expect(store.getStore()).toBe(42)
        return 99
      })
      expect(result).toBe(99)
      expect(result).not.toBeInstanceOf(Promise)
      expect(store.getStore()).toBeUndefined()
    })

    it("restores the previous value on exit when nested", () => {
      const store = new AsyncLocalStorage()
      const outer = store.run("outer", () => {
        expect(store.getStore()).toBe("outer")
        const inner = store.run("inner", () => {
          expect(store.getStore()).toBe("inner")
          return "inner-result"
        })
        expect(inner).toBe("inner-result")
        expect(store.getStore()).toBe("outer")
        return "outer-result"
      })
      expect(outer).toBe("outer-result")
      expect(store.getStore()).toBeUndefined()
    })

    it("returns the callback value and propagates the exception restoring the store", () => {
      const store = new AsyncLocalStorage()
      let threw = false
      try {
        store.run(123, () => {
          throw new Error("callback error")
        })
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
      expect(store.getStore()).toBeUndefined()
    })

    it("restores the store even when the callback throws", () => {
      const store = new AsyncLocalStorage()
      try {
        store.run(999, () => {
          throw new Error("oops")
        })
      } catch {
        // expected
      }
      expect(store.getStore()).toBeUndefined()
    })

    it("works with nested run calls - outer restored after inner", () => {
      const store = new AsyncLocalStorage()
      const result = store.run("first", () => {
        expect(store.getStore()).toBe("first")
        const innerResult = store.run("second", () => {
          expect(store.getStore()).toBe("second")
          return "inner-done"
        })
        expect(innerResult).toBe("inner-done")
        expect(store.getStore()).toBe("first")
        return "outer-done"
      })
      expect(result).toBe("outer-done")
      expect(store.getStore()).toBeUndefined()
    })
  })
})
