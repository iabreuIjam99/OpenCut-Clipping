import { defineConfig } from "vite";

// Spike Whisper WebGPU (Task 7): puerto 5176 fijo + aislamiento de origen.
// Sin COOP/COEP/CORP, `crossOriginIsolated` es false y no corre
// `performance.measureUserAgentSpecificMemory()` (UASM). Las cabeceras van
// también en `preview` por el mismo motivo que en Task 6.
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

export default defineConfig({
  server: {
    port: 5176,
    strictPort: true,
    headers,
  },
  preview: {
    port: 5176,
    strictPort: true,
    headers,
  },
});
