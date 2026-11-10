export interface QuotaStore {
  consume(ipHash: string, day: string): Promise<number>
}

export type QuotaResult = { allowed: boolean; remaining: number }

export class QuotaConfigError extends Error {
  constructor() {
    super("Configuración de cuota inválida.")
    this.name = "QuotaConfigError"
  }
}

export class QuotaStoreError extends Error {
  constructor() {
    super("No se pudo consultar la cuota.")
    this.name = "QuotaStoreError"
  }
}

const HASH_RE = /^[a-f0-9]{64}$/

export async function consumeQuota(
  store: QuotaStore,
  ipHash: string,
  options: { limit: number; now?: Date },
): Promise<QuotaResult> {
  if (!HASH_RE.test(ipHash)) throw new QuotaConfigError()
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10_000) {
    throw new QuotaConfigError()
  }
  const now = options.now ?? new Date()
  if (Number.isNaN(now.getTime())) throw new QuotaConfigError()
  const day = now.toISOString().slice(0, 10)
  const count = await store.consume(ipHash, day)
  if (!Number.isInteger(count) || count < 1) throw new QuotaStoreError()
  return { allowed: count <= options.limit, remaining: Math.max(0, options.limit - count) }
}

export function parseQuotaLimit(raw: string | undefined, fallback = 20): number {
  if (raw === undefined) return fallback
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return fallback
  const n = Number(trimmed)
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : fallback
}

export interface D1QuotaStatement {
  bind(...values: unknown[]): D1QuotaStatement
  first(): Promise<unknown>
}
export interface D1QuotaDatabase {
  prepare(query: string): D1QuotaStatement
}

function isCountRow(value: unknown): value is { count: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "count") &&
    "count" in value &&
    typeof value.count === "number" &&
    Number.isInteger(value.count)
  )
}

export function createD1QuotaStore(db: D1QuotaDatabase): QuotaStore {
  return {
    consume: async (ipHash, day) => {
      const row: unknown = await db
        .prepare(
          "INSERT INTO quota_counters (ip_hash, day, count) VALUES (?, ?, 1) ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1 RETURNING count",
        )
        .bind(ipHash, day)
        .first()
      if (!isCountRow(row) || row.count < 1) throw new QuotaStoreError()
      return row.count
    },
  }
}

export async function hashIp(salt: string, ip: string): Promise<string> {
  if (salt.trim().length === 0 || ip.trim().length === 0 || ip !== ip.trim() || ip.length > 128) {
    throw new QuotaConfigError()
  }
  const data = new TextEncoder().encode(`${salt}:${ip}`)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}
