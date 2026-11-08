import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Copies the ffmpeg core into public/core/ so the dev server serves it RAW.
 * Vite's transform middleware would otherwise rewrite ffmpeg-core.js (an
 * Emscripten classic script loaded via importScripts inside the ffmpeg worker),
 * which breaks the core. public/ is served before the transform middleware.
 */
function copyFfmpegCore(): void {
  // @ffmpeg/ffmpeg creates its worker with `{ type: "module" }`, so
  // `importScripts()` throws and the worker falls back to dynamic `import()`.
  // Therefore the ESM build of the core is the one that must be served.
  const wanted: ReadonlyArray<readonly [string, string]> = [
    ["@ffmpeg/core/dist/esm/ffmpeg-core.js", "core/ffmpeg-core.js"],
    ["@ffmpeg/core/dist/esm/ffmpeg-core.wasm", "core/ffmpeg-core.wasm"],
    ["@ffmpeg/core-mt/dist/esm/ffmpeg-core.js", "core-mt/ffmpeg-core.js"],
    ["@ffmpeg/core-mt/dist/esm/ffmpeg-core.wasm", "core-mt/ffmpeg-core.wasm"],
    ["@ffmpeg/core-mt/dist/esm/ffmpeg-core.worker.js", "core-mt/ffmpeg-core.worker.js"],
  ];
  for (const [from, to] of wanted) {
    const src = resolve(here, "node_modules", from);
    if (!existsSync(src)) continue;
    const dest = resolve(here, "public", to);
    mkdirSync(dirname(dest), { recursive: true });
    if (!existsSync(dest)) cpSync(src, dest);
  }

  // El worker de @ffmpeg/ffmpeg se pasa explícito con `classWorkerURL` para no
  // depender de cómo Vite pre-empaquete la librería (`new URL("./worker.js",
  // import.meta.url)` apuntaría a un fichero inexistente). Se copian todas sus
  // dependencias relativas (const.js, errors.js, utils.js).
  const workerSrc = resolve(here, "node_modules", "@ffmpeg", "ffmpeg", "dist", "esm");
  if (existsSync(workerSrc)) {
    const destDir = resolve(here, "public", "ffmpeg");
    mkdirSync(destDir, { recursive: true });
    for (const entry of readdirSync(workerSrc)) {
      if (!entry.endsWith(".js")) continue;
      const dest = resolve(destDir, entry);
      if (!existsSync(dest)) cpSync(resolve(workerSrc, entry), dest);
    }
  }
}

copyFfmpegCore();

export default defineConfig({
  server: {
    port: 5175,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  },
  preview: {
    port: 5175,
    strictPort: true,
  },
});
