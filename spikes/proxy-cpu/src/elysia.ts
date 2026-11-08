import { Elysia } from "elysia";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import { burnCpu, burnMsFrom } from "./burn";
import { proxyStream } from "./proxy";

/**
 * Misma ruta, pero montada en Elysia 1.4.30 con el adapter de Cloudflare Workers.
 * `POST /proxy` NO declara `body` en el schema: es justo el caso que hay que medir
 * (¿Elysia consume el stream por defecto aunque no haya schema?).
 *
 * Se exporta la instancia igual que `apps/api/src/index.ts` (`.compile()` incluido)
 * para que la comparación sea con el patrón real de la app.
 */
export default new Elysia({ adapter: CloudflareAdapter })
  .get("/health", () => "ok")
  .get("/burn", ({ request }) => burnCpu(burnMsFrom(request)))
  .post("/proxy", ({ request }) => proxyStream(request))
  .compile();
