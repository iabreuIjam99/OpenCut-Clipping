import { describe, expect, it } from "vitest"
import type { D1QuotaDatabase, D1QuotaStatement, QuotaStore } from "./quota"
import {
  consumeQuota,
  createD1QuotaStore,
  hashIp,
  parseQuotaLimit,
  QuotaConfigError,
  QuotaStoreError,
} from "./quota"

const HASH = "a".repeat(64)

function fixedStore(count: number): QuotaStore {
  return { consume: async () => count }
}

describe("consumeQuota", () => {
  it("permite hasta el límite", async () => {
    await expect(consumeQuota(fixedStore(3), HASH, { limit: 3 })).resolves.toEqual({
      allowed: true,
      remaining: 0,
    })
  })

  it("bloquea por encima del límite", async () => {
    await expect(consumeQuota(fixedStore(4), HASH, { limit: 3 })).resolves.toEqual({
      allowed: false,
      remaining: 0,
    })
  })

  it("usa el día UTC", async () => {
    let seenDay = ""
    const store: QuotaStore = {
      consume: async (_hash, day) => {
        seenDay = day
        return 1
      },
    }
    await consumeQuota(store, HASH, { limit: 3, now: new Date("2024-01-15T23:59:59.000Z") })
    expect(seenDay).toBe("2024-01-15")
  })

  it("usa new Date() si no se inyecta reloj", async () => {
    await expect(consumeQuota(fixedStore(1), HASH, { limit: 3 })).resolves.toEqual({
      allowed: true,
      remaining: 2,
    })
  })

  it("rechaza hash no hex-64", async () => {
    await expect(consumeQuota(fixedStore(1), "1.2.3.4", { limit: 3 })).rejects.toBeInstanceOf(
      QuotaConfigError,
    )
    await expect(consumeQuota(fixedStore(1), "A".repeat(64), { limit: 3 })).rejects.toBeInstanceOf(
      QuotaConfigError,
    )
  })

  it("rechaza límites inválidos", async () => {
    for (const limit of [0, -1, 1.5, 10_001, Number.NaN]) {
      await expect(consumeQuota(fixedStore(1), HASH, { limit })).rejects.toBeInstanceOf(
        QuotaConfigError,
      )
    }
  })

  it("rechaza reloj inválido", async () => {
    await expect(
      consumeQuota(fixedStore(1), HASH, { limit: 3, now: new Date("x") }),
    ).rejects.toBeInstanceOf(QuotaConfigError)
  })

  it("rechaza counts inválidos del store", async () => {
    for (const count of [0, -1, 1.5, Number.NaN]) {
      await expect(consumeQuota(fixedStore(count), HASH, { limit: 3 })).rejects.toBeInstanceOf(
        QuotaStoreError,
      )
    }
  })
})

describe("parseQuotaLimit", () => {
  it("acepta enteros 1..10000 y rechaza el resto", () => {
    expect(parseQuotaLimit(undefined)).toBe(20)
    expect(parseQuotaLimit("7")).toBe(7)
    expect(parseQuotaLimit(" 7 ")).toBe(7)
    expect(parseQuotaLimit("0")).toBe(20)
    expect(parseQuotaLimit("-3")).toBe(20)
    expect(parseQuotaLimit("3.5")).toBe(20)
    expect(parseQuotaLimit("abc")).toBe(20)
    expect(parseQuotaLimit("10001")).toBe(20)
  })
})

describe("createD1QuotaStore", () => {
  it("hace el upsert y devuelve count", async () => {
    let sql = ""
    let binds: unknown[] = []
    const stmt: D1QuotaStatement = {
      bind(...values) {
        binds = values
        return stmt
      },
      first: async () => ({ count: 1 }),
    }
    const db: D1QuotaDatabase = {
      prepare(query) {
        sql = query
        return stmt
      },
    }
    await expect(createD1QuotaStore(db).consume(HASH, "2024-01-15")).resolves.toBe(1)
    expect(sql).toContain("ON CONFLICT")
    expect(sql).toContain("RETURNING count")
    expect(binds).toEqual([HASH, "2024-01-15"])
  })

  it("falla si la fila es null o el count inválido", async () => {
    for (const row of [null, { count: 0 }, { count: 1.5 }]) {
      const stmt: D1QuotaStatement = {
        bind() {
          return stmt
        },
        first: async () => row,
      }
      const db: D1QuotaDatabase = { prepare: () => stmt }
      await expect(createD1QuotaStore(db).consume(HASH, "2024-01-15")).rejects.toBeInstanceOf(
        QuotaStoreError,
      )
    }
  })

  it("rechaza un count heredado por prototipo", async () => {
    const polluted: unknown = Object.create({ count: 1 })
    const stmt: D1QuotaStatement = {
      bind() {
        return stmt
      },
      first: async () => polluted,
    }
    const db: D1QuotaDatabase = { prepare: () => stmt }
    await expect(createD1QuotaStore(db).consume(HASH, "2024-01-15")).rejects.toBeInstanceOf(
      QuotaStoreError,
    )
  })
})

describe("hashIp", () => {
  it("devuelve 64 hex y no contiene la IP", async () => {
    const hash = await hashIp("salt", "1.2.3.4")
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(hash).not.toContain("1.2.3.4")
  })

  it("coincide con SHA-256 de salt:ip", async () => {
    const expected = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode("salt:1.2.3.4")),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("")
    await expect(hashIp("salt", "1.2.3.4")).resolves.toBe(expected)
  })

  it("rechaza sal o IP vacías y IP demasiado larga", async () => {
    await expect(hashIp("", "1.2.3.4")).rejects.toBeInstanceOf(QuotaConfigError)
    await expect(hashIp("salt", "")).rejects.toBeInstanceOf(QuotaConfigError)
    await expect(hashIp("salt", "x".repeat(129))).rejects.toBeInstanceOf(QuotaConfigError)
    await expect(hashIp("salt", " 1.2.3.4 ")).rejects.toBeInstanceOf(QuotaConfigError)
  })
})
