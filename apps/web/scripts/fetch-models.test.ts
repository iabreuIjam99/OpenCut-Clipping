import { spawnSync } from "node:child_process"
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Unit tests for the model downloader (Task 12, R3/R7): `--check` must exit 1
 * for an empty models directory and 0 when the nine pinned files plus the
 * manifest are present. The script exposes `MONETIZA_MODELS_ROOT` as a
 * test-only seam so both checks run against a temporary directory without
 * touching `public/models/` (never committed, `.gitignore`).
 *
 * The "present" files are sparse (`ftruncate`): the script validates SIZE, so
 * exact-size holes are enough — no 286 MB of real bytes are written.
 */

// Vitest serves modules over http://, so `import.meta.url` is not a file URL:
// resolve from cwd instead (same approach as `extract-audio.test.ts`).
const script = resolve(process.cwd(), "scripts", "fetch-models.mjs")

/** The 9 pinned files from R3, with their exact byte sizes at the revision. */
const MODEL_FILES: ReadonlyArray<readonly [string, number]> = [
  ["config.json", 2243],
  ["generation_config.json", 3832],
  ["preprocessor_config.json", 339],
  ["tokenizer.json", 2480466],
  ["tokenizer_config.json", 282682],
  ["onnx/encoder_model.onnx", 82468078],
  ["onnx/decoder_model_merged_q4.onnx", 123602419],
  ["onnx/encoder_model_quantized.onnx", 23201314],
  ["onnx/decoder_model_merged_quantized.onnx", 53693315],
]

function writeSparse(path: string, bytes: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const handle = openSync(path, "w")
  try {
    ftruncateSync(handle, bytes)
  } finally {
    closeSync(handle)
  }
}

function checkOptions(modelsRoot: string): {
  env: NodeJS.ProcessEnv
  encoding: "utf8"
  timeout: number
} {
  return {
    env: { ...process.env, MONETIZA_MODELS_ROOT: modelsRoot },
    encoding: "utf8",
    timeout: 15_000,
  }
}

describe("fetch-models.mjs --check", () => {
  it("exits 1 for an empty models directory", () => {
    const root = mkdtempSync(join(tmpdir(), "monetiza-models-"))
    try {
      const result = spawnSync(process.execPath, [script, "--check"], checkOptions(root))

      expect(result.status).toBe(1)
      expect(result.stderr).toContain("models:check FALLA")
      expect(result.stderr).toContain("config.json (ausente)")
      expect(result.stderr).toContain("encoder_model.onnx (ausente)")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("exits 0 when the nine pinned files and the manifest are present", () => {
    const root = mkdtempSync(join(tmpdir(), "monetiza-models-"))
    try {
      const modelDir = join(root, "onnx-community", "whisper-base")
      for (const [path, bytes] of MODEL_FILES) writeSparse(join(modelDir, path), bytes)
      writeFileSync(join(modelDir, ".manifest.json"), "{}\n")

      const result = spawnSync(process.execPath, [script, "--check"], checkOptions(root))

      expect(result.status).toBe(0)
      expect(result.stdout).toContain("models:check OK")
      expect(result.stdout).toContain("9 ficheros")
      expect(result.stdout).toContain("285734688 B")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
