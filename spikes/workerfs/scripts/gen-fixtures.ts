/**
 * Generates the local test fixtures with the ffmpeg binary shipped by the
 * `ffmpeg-static` devDependency. Fixtures are NEVER downloaded, NEVER committed.
 *
 *   bun scripts/gen-fixtures.ts [--force]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegStatic from "ffmpeg-static";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "..", "fixtures");

interface FixtureSpec {
  readonly file: string;
  readonly durationS: number;
  readonly videoBitrate: string | null;
  readonly note: string;
}

const SPECS: readonly FixtureSpec[] = [
  { file: "short-30s.mp4", durationS: 30, videoBitrate: null, note: "warm-up, CRF default" },
  { file: "medium-10min.mp4", durationS: 600, videoBitrate: "6800k", note: "~500 MB target (CBR)" },
  { file: "large-2gb.mp4", durationS: 3600, videoBitrate: "5000k", note: "1 h, >2^31 bytes target (CBR)" },
];

const force: boolean = process.argv.includes("--force");

function human(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

function buildArgs(spec: FixtureSpec, outPath: string): string[] {
  const args: string[] = [
    "-y",
    "-hide_banner",
    "-nostdin",
    "-f", "lavfi",
    "-i", "testsrc=size=1280x720:rate=30",
    "-f", "lavfi",
    "-i", "sine=frequency=440",
    "-t", String(spec.durationS),
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
  ];
  if (spec.videoBitrate !== null) {
    // ABR alone is not enough: `testsrc` is too compressible and x264 stops at
    // its QP floor (~1.4 Mbps instead of the requested rate). Forced CBR with
    // filler NAL units makes the file size deterministic: bitrate x duration.
    args.push(
      "-b:v", spec.videoBitrate,
      "-maxrate", spec.videoBitrate,
      "-bufsize", spec.videoBitrate,
      "-x264-params", "nal-hrd=cbr",
    );
  }
  args.push("-c:a", "aac", "-b:a", "128k", "-shortest", "-progress", "pipe:1", "-nostats", outPath);
  return args;
}

function generate(ffmpeg: string, spec: FixtureSpec): Promise<number> {
  const outPath = resolve(fixturesDir, spec.file);
  const args = buildArgs(spec, outPath);
  console.log(`\n=== ${spec.file} (${spec.note})`);
  console.log(`cmd: ffmpeg ${args.join(" ")}\n`);
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    let lastReport = Date.now();
    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        const m = /^out_time_ms=(\d+)$/.exec(line.trim());
        if (m && m[1] && Date.now() - lastReport > 5000) {
          lastReport = Date.now();
          const secs = Number(m[1]) / 1_000_000;
          console.log(`  ... ${secs.toFixed(0)}s of ${spec.durationS}s encoded`);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text.length > 0) console.log(`  [ff] ${text.split(/\r?\n/).slice(-1).join(" ")}`);
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise(code ?? -1));
  });
}

async function main(): Promise<void> {
  if (ffmpegStatic === null) throw new Error("ffmpeg-static binary not resolved");
  mkdirSync(fixturesDir, { recursive: true });
  console.log(`ffmpeg binary: ${ffmpegStatic}`);
  const started = Date.now();
  for (const spec of SPECS) {
    const outPath = resolve(fixturesDir, spec.file);
    if (!force && existsSync(outPath) && statSync(outPath).size > 0) {
      console.log(`skip ${spec.file} (already exists, use --force to regenerate)`);
      continue;
    }
    const code = await generate(ffmpegStatic, spec);
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code} for ${spec.file}`);
    const size = statSync(outPath).size;
    console.log(`OK ${spec.file}: ${size} bytes (${human(size)})`);
  }
  console.log(`\nall fixtures done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((e: unknown) => {
  console.error("FAILED:", e);
  process.exit(1);
});
