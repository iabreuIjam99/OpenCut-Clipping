#!/usr/bin/env node
/**
 * Descarga los pesos de `onnx-community/whisper-base` (revisión pinneada) a
 * `public/models/onnx-community/whisper-base/` — solo desde Hugging Face, sin
 * tokens, sin telemetría y sin escribir fuera de ese directorio (Task 12, R3).
 *
 * Uso (desde `apps/web`):
 *   bun run models:fetch           descarga/verifica y escribe `.manifest.json`
 *   bun run models:fetch --check   solo valida; sale con código 1 si falta algo
 *
 * MVP: solo se soporta `whisper-base` (los 9 ficheros siguientes, incluidos
 * los `_quantized` que necesita el fallback WASM q8). `whisper-small` u otros
 * modelos se añadirán cuando exista un `models:fetch --model <modelo>`.
 *
 * Los tamaños son los de la revisión pinneada (inmutables en HF): un fichero
 * ya presente con el tamaño exacto se salta. Los JSON se comprueban contra su
 * tamaño real (que además es > 0: «no vacíos», R3).
 *
 * Costura SOLO para tests: `MONETIZA_MODELS_ROOT` redirige la raíz de modelos
 * (el test de `--check` usa un directorio temporal vacío; ningún otro código
 * debe tocar esa variable).
 */

import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REVISION = "27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c"
const REPO = "onnx-community/whisper-base"
const RESOLVE_BASE = `https://huggingface.co/${REPO}/resolve/${REVISION}`

/** Los 9 ficheros pineados (R3): JSONs en la raíz del repo, ONNX bajo `onnx/`. */
const FILES = [
  { path: "config.json", bytes: 2243 },
  { path: "generation_config.json", bytes: 3832 },
  { path: "preprocessor_config.json", bytes: 339 },
  { path: "tokenizer.json", bytes: 2480466 },
  { path: "tokenizer_config.json", bytes: 282682 },
  { path: "onnx/encoder_model.onnx", bytes: 82468078 },
  { path: "onnx/decoder_model_merged_q4.onnx", bytes: 123602419 },
  // Fallback WASM (dtype q8, `WASM_DTYPE` del Worker): sin ellos el
  // reintento a CPU no puede cargar el modelo.
  { path: "onnx/encoder_model_quantized.onnx", bytes: 23201314 },
  { path: "onnx/decoder_model_merged_quantized.onnx", bytes: 53693315 },
]

const TOTAL_BYTES = FILES.reduce((sum, file) => sum + file.bytes, 0)

const here = dirname(fileURLToPath(import.meta.url))
const modelsRoot = process.env.MONETIZA_MODELS_ROOT ?? resolve(here, "..", "public", "models")
const modelDir = join(modelsRoot, ...REPO.split("/"))
const manifestPath = join(modelDir, ".manifest.json")

function destFor(path) {
  return join(modelDir, ...path.split("/"))
}

/** @returns {string[]} motivos por los que la instalación local no es válida. */
function validate() {
  const problems = []
  for (const file of FILES) {
    const dest = destFor(file.path)
    if (!existsSync(dest)) {
      problems.push(`${file.path} (ausente)`)
      continue
    }
    const size = statSync(dest).size
    if (size !== file.bytes) problems.push(`${file.path} (${size} B, esperado ${file.bytes} B)`)
  }
  if (!existsSync(manifestPath)) problems.push(".manifest.json (ausente)")
  return problems
}

async function download(file) {
  const dest = destFor(file.path)
  if (existsSync(dest) && statSync(dest).size === file.bytes) {
    console.log(`= ${file.path} (ya presente, ${file.bytes} B)`)
    return
  }

  const url = `${RESOLVE_BASE}/${file.path}`
  console.log(`> ${file.path} …`)
  const response = await fetch(url, { redirect: "follow" })
  if (!response.ok) throw new Error(`HTTP ${response.status} al descargar ${file.path}`)

  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length !== file.bytes) {
    throw new Error(`${file.path}: ${bytes.length} B descargados, esperados ${file.bytes} B`)
  }

  mkdirSync(dirname(dest), { recursive: true })
  const partial = `${dest}.part`
  try {
    writeFileSync(partial, bytes)
    renameSync(partial, dest)
  } catch (error) {
    if (existsSync(partial)) unlinkSync(partial)
    throw error
  }
  console.log(`+ ${file.path} (${file.bytes} B)`)
}

function writeManifest() {
  const manifest = {
    name: REPO,
    revision: REVISION,
    files: FILES.map((file) => ({ path: file.path, bytes: file.bytes })),
    totalBytes: TOTAL_BYTES,
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function main() {
  if (process.argv.includes("--check")) {
    const problems = validate()
    if (problems.length > 0) {
      console.error(`models:check FALLA — ${problems.length} problema(s) en ${modelDir}:`)
      for (const problem of problems) console.error(`  - ${problem}`)
      process.exitCode = 1
      return
    }
    console.log(`models:check OK — ${FILES.length} ficheros, ${TOTAL_BYTES} B en ${modelDir}`)
    return
  }

  mkdirSync(modelDir, { recursive: true })
  for (const file of FILES) await download(file)
  writeManifest()
  console.log(`Modelo listo: ${modelDir} (${FILES.length} ficheros, ${TOTAL_BYTES} B)`)
}

main().catch((error) => {
  console.error(`models:fetch falló: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
