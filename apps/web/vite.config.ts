import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { cloudflare } from "@cloudflare/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Copies the ffmpeg.wasm assets into public/ so they are served LOCALLY at
 * `/ffmpeg-core/*` and `/ffmpeg/*` (never from a CDN, R2).
 *
 * They must live in public/ and not in src/: Vite's transform middleware would
 * rewrite `ffmpeg-core.js` (an Emscripten script loaded via import() inside the
 * ffmpeg worker) and break the core; public/ is served before that middleware.
 *
 * The copies are generated (~31 MB) and git-ignored: only this plugin creates
 * them, and only when missing (delete public/ffmpeg* to refresh).
 */
function copyFfmpegAssets(): void {
  const wanted: ReadonlyArray<readonly [string, string]> = [
    ["@ffmpeg/core/dist/esm/ffmpeg-core.js", "ffmpeg-core/ffmpeg-core.js"],
    ["@ffmpeg/core/dist/esm/ffmpeg-core.wasm", "ffmpeg-core/ffmpeg-core.wasm"],
  ]
  for (const [from, to] of wanted) {
    const src = resolve(here, "node_modules", from)
    if (!existsSync(src)) {
      throw new Error(`[ffmpeg-assets] falta ${from}; ejecuta bun install en apps/web`)
    }
    const dest = resolve(here, "public", to)
    mkdirSync(dirname(dest), { recursive: true })
    if (!existsSync(dest)) cpSync(src, dest)
  }

  // The worker is passed explicitly with `classWorkerURL`; its relative
  // imports (const.js, errors.js, utils.js, …) must sit next to it.
  const workerSrc = resolve(here, "node_modules", "@ffmpeg", "ffmpeg", "dist", "esm")
  if (!existsSync(workerSrc)) {
    throw new Error("[ffmpeg-assets] falta @ffmpeg/ffmpeg/dist/esm; ejecuta bun install")
  }
  const destDir = resolve(here, "public", "ffmpeg")
  mkdirSync(destDir, { recursive: true })
  for (const entry of readdirSync(workerSrc)) {
    if (!entry.endsWith(".js")) continue
    const dest = resolve(destDir, entry)
    if (!existsSync(dest)) cpSync(resolve(workerSrc, entry), dest)
  }
}

copyFfmpegAssets()

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
