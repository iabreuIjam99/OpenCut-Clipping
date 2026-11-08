import { burnCpu, burnMsFrom } from "./burn";
import { proxyStream } from "./proxy";

/**
 * Worker mínimo: `fetch` puro, sin framework. Es la línea base del spike.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    // Ruta de CALIBRACIÓN del profiler (no participa en las tablas de /proxy):
    // quema CPU de JS de forma controlada para validar el método de medición.
    if (url.pathname === "/burn") {
      return new Response(burnCpu(burnMsFrom(request)), {
        headers: { "content-type": "text/plain" },
      });
    }

    if (url.pathname === "/proxy") {
      request.signal.addEventListener("abort", () => {
        console.log("[minimal] request.signal abort");
      });
      return proxyStream(request);
    }

    return new Response("not found", { status: 404 });
  },
};
