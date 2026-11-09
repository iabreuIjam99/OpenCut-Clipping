import { Elysia, t } from "elysia"
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker"
import { transcribeRoute } from "./modules/clipping/transcribe.route"

export default new Elysia({ adapter: CloudflareAdapter })
  .get("/", () => ({ status: "ok" }))
  .get("/health", () => ({ healthy: true, timestamp: new Date().toISOString() }))
  .post("/echo", ({ body }) => body, {
    body: t.Object({ message: t.String() }),
  })
  .use(transcribeRoute)
  // .compile() is required, it triggers AoT compilation at startup
  .compile()
