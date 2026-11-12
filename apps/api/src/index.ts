import { env } from "cloudflare:workers"
import type { D1Database } from "@cloudflare/workers-types"
import { Elysia, t } from "elysia"
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker"
import { createAnalyzeRoute } from "./modules/clipping/analyze.route"
import type { AiBinding } from "./modules/clipping/providers/workers-ai"
import { createD1QuotaStore, parseQuotaLimit } from "./modules/clipping/quota"
import type { RuntimeSecurity } from "./modules/clipping/transcribe.route"
import { createTranscribeRoute } from "./modules/clipping/transcribe.route"
import { createTurnstileVerifier } from "./modules/clipping/turnstile"

declare global {
  namespace Cloudflare {
    interface Env {
      DB?: D1Database
      /**
       * Binding de Workers AI. Declaramos solo la superficie que llamamos
       * (`run(model, input)`), porque el tipo del SDK es más estrecho que lo
       * que necesita el proveedor y evita una aserción de tipo.
       */
      AI?: AiBinding
      TURNSTILE_SECRET?: string
      IP_HASH_SALT?: string
      QUOTA_DAILY_LIMIT?: string
    }
  }
}

const turnstileSecret = env.TURNSTILE_SECRET
const db = env.DB
const ai = env.AI
const ipHashSalt = env.IP_HASH_SALT
const quotaDailyLimit = env.QUOTA_DAILY_LIMIT

const turnstile = turnstileSecret ? createTurnstileVerifier({ secret: turnstileSecret }) : null

const quota = db ? { store: createD1QuotaStore(db), limit: parseQuotaLimit(quotaDailyLimit) } : null

const security: RuntimeSecurity = {
  turnstile,
  quota,
  ipHashSalt: ipHashSalt ?? null,
  required: true,
}

export default new Elysia({ adapter: CloudflareAdapter })
  .get("/", () => ({ status: "ok" }))
  .get("/health", () => ({ healthy: true, timestamp: new Date().toISOString() }))
  .post("/echo", ({ body }) => body, { body: t.Object({ message: t.String() }) })
  .use(createTranscribeRoute({ security }))
  .use(createAnalyzeRoute({ security, ai: ai ?? null }))
  .compile()
