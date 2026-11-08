import { Elysia, t } from "elysia";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import { burnCpu, burnMsFrom } from "./burn";
import { proxyStream } from "./proxy";

/**
 * VARIANTE DE CONTROL (trampa de buffering): misma app Elysia, pero `POST /proxy`
 * declara `body: t.Any()`.
 *
 * Con un schema de body, Elysia activa su parser por defecto
 * (`hasBodyInference` pasa a true) y para `multipart/form-data` llama a
 * `request.formData()`, que consume el stream ANTES del handler. Esta variante
 * demuestra cuánto cuesta (en CPU y en buffering) hacer lo que el plan original
 * sugería. NO es la implementación recomendada.
 */
export default new Elysia({ adapter: CloudflareAdapter })
  .get("/health", () => "ok")
  .get("/burn", ({ request }) => burnCpu(burnMsFrom(request)))
  .post("/proxy", ({ request }) => proxyStream(request), { body: t.Any() })
  .compile();
