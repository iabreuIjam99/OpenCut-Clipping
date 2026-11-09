/**
 * Deriva `results/bench-summary.json` (versionado) desde `results/bench.json`
 * (gitignored, porque contiene traces por chunk, muestras de heap y frames).
 * Solo agrega las métricas que cita `RESULT.md`.
 *
 *   bun scripts/summarize.ts        # deriva el resumen del bench.json actual
 *
 * `scripts/bench.ts` lo llama al final de cada corrida, de modo que el resumen
 * versionado se regenera solo.
 */

interface RawStats {
  n?: number;
  p50?: number;
  p95?: number;
  max?: number;
  mean?: number;
}

interface RawConfig {
  config?: {
    id?: string;
    sizeMb?: number;
    chunkKb?: number;
    rateMb?: number;
    multipart?: boolean;
    status?: number;
    repeat?: number;
    reps?: number;
    idleWindows?: number;
  };
  requests?: number;
  cpuUs?: RawStats;
  nonIdleSamples?: RawStats;
  intervalUs?: number;
  noiseUs?: RawStats;
  wallMs?: RawStats;
  cpuPerMbUpperUs?: number;
  cpuPerChunkUpperUs?: number;
  statuses?: Record<string, number>;
  processCpuUsPerRequest?: number | null;
  buffering?: {
    shaMatch?: boolean;
    sentBytes?: number;
    receivedBytes?: number;
    firstByteDelayMs?: number;
    lastByteDelayMs?: number;
    uploadSpanMs?: number;
    sinkSpanMs?: number;
    maxGapMs?: number;
    maxProgressDriftPct?: number;
  };
}

interface RawRss {
  workingSetBytes?: number;
  peakWorkingSetBytes?: number;
  processCount?: number;
}

interface RawMemory {
  sizeMb?: number;
  rateMb?: number;
  sampleCount?: number;
  baseline?: { usedSize?: number; totalSize?: number } | null;
  peak?: { usedSize?: number; totalSize?: number } | null;
  after?: { usedSize?: number; totalSize?: number } | null;
  peakDeltaBytes?: number | null;
  afterDeltaBytes?: number | null;
  upload?: { status?: number; sentBytes?: number; wallMs?: number };
  processRss?: { before?: RawRss | null; after?: RawRss | null };
  notes?: string[];
}

interface RawImpl {
  configs?: Record<string, RawConfig>;
  calibration?: { intervalUs?: number; burnMs?: number; runs?: unknown[] };
  memory?: RawMemory[];
}

interface RawBench {
  meta?: {
    startedAt?: string;
    mergedAt?: string;
    host?: string;
    platform?: string;
    bun?: string;
    repeat?: number;
    reps?: number;
    idleWindows?: number;
    sinkPort?: number;
    note?: string;
  };
  impls?: Record<string, RawImpl>;
}

const SOURCE_PATH = "results/bench.json";
const OUTPUT_PATH = "results/bench-summary.json";
const REQUESTED_INTERVAL_US = 100;

function round(value: number | null | undefined, digits = 3): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function gitInfo(): { head: string; subject: string } {
  try {
    const head = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
      stdout: "pipe",
      stderr: "ignore",
    })
      .stdout.toString()
      .trim();
    const subject = Bun.spawnSync(["git", "log", "-1", "--format=%s"], {
      stdout: "pipe",
      stderr: "ignore",
    })
      .stdout.toString()
      .trim();
    return { head: head.length > 0 ? head : "unknown", subject: subject.length > 0 ? subject : "unknown" };
  } catch {
    return { head: "unknown", subject: "unknown" };
  }
}

function summarizeMemory(memory: RawMemory) {
  const before = memory.processRss?.before ?? null;
  const after = memory.processRss?.after ?? null;
  return {
    sizeMb: memory.sizeMb ?? null,
    rateMb: memory.rateMb ?? null,
    method: {
      cdpMethod: "Runtime.getHeapUsage",
      sampleIntervalMs: 50,
      settleMs: 500,
      crossCheck: "Performance.getMetrics no soportado en workerd 2026-10-23",
    },
    samples: memory.sampleCount ?? 0,
    usedSize: {
      baseline: memory.baseline?.usedSize ?? null,
      peak: memory.peak?.usedSize ?? null,
      after: memory.after?.usedSize ?? null,
      peakDelta: memory.peakDeltaBytes ?? null,
      afterDelta: memory.afterDeltaBytes ?? null,
      totalSize: memory.peak?.totalSize ?? null,
    },
    upload: {
      status: memory.upload?.status ?? null,
      sentBytes: memory.upload?.sentBytes ?? null,
      wallMs: round(memory.upload?.wallMs, 1),
    },
    rss: {
      beforeBytes: before?.workingSetBytes ?? null,
      afterBytes: after?.workingSetBytes ?? null,
      deltaBytes:
        typeof before?.workingSetBytes === "number" && typeof after?.workingSetBytes === "number"
          ? after.workingSetBytes - before.workingSetBytes
          : null,
      peakBeforeBytes: before?.peakWorkingSetBytes ?? null,
      peakAfterBytes: after?.peakWorkingSetBytes ?? null,
      processCount: before?.processCount ?? null,
    },
    notes: memory.notes ?? [],
  };
}

function summarizeConfig(config: RawConfig, calibrationIntervalUs: number) {
  const cfg = config.config ?? {};
  const samples = {
    p50: round(config.nonIdleSamples?.p50, 2) ?? 0,
    p95: round(config.nonIdleSamples?.p95, 2) ?? 0,
    max: round(config.nonIdleSamples?.max, 2) ?? 0,
  };
  const intervalUs = config.intervalUs ?? calibrationIntervalUs;
  const buffering = config.buffering ?? {};

  return {
    sizeMb: cfg.sizeMb ?? null,
    chunkKb: cfg.chunkKb ?? null,
    rateMb: cfg.rateMb ?? null,
    multipart: cfg.multipart ?? null,
    expectedStatus: cfg.status ?? null,
    requests: config.requests ?? null,
    repeat: cfg.repeat ?? null,
    reps: cfg.reps ?? null,
    statuses: config.statuses ?? {},
    cpu: {
      nonIdleSamples: samples,
      cpuUs: {
        p50: round(config.cpuUs?.p50) ?? 0,
        p95: round(config.cpuUs?.p95) ?? 0,
        max: round(config.cpuUs?.max) ?? 0,
        mean: round(config.cpuUs?.mean) ?? 0,
      },
      intervalUs: round(intervalUs) ?? 0,
      // Cota superior defendible: muestras máximas × intervalo calibrado.
      upperBoundUs: round(samples.max * intervalUs) ?? 0,
      noiseSamples: {
        p50: config.noiseUs?.p50 ?? 0,
        p95: config.noiseUs?.p95 ?? 0,
        max: config.noiseUs?.max ?? 0,
      },
      cpuPerMbUpperUs: round(config.cpuPerMbUpperUs) ?? null,
      cpuPerChunkUpperUs: round(config.cpuPerChunkUpperUs) ?? null,
    },
    processCpuUsPerRequest: config.processCpuUsPerRequest ?? null,
    bytes: {
      sent: buffering.sentBytes ?? null,
      received: buffering.receivedBytes ?? null,
      shaMatch: buffering.shaMatch ?? null,
    },
    timingMs: {
      firstByte: buffering.firstByteDelayMs ?? null,
      lastByte: buffering.lastByteDelayMs ?? null,
      uploadSpan: buffering.uploadSpanMs ?? null,
      sinkSpan: buffering.sinkSpanMs ?? null,
      maxGap: round(buffering.maxGapMs) ?? null,
      wallP50: round(config.wallMs?.p50, 1) ?? null,
    },
    driftPct: round(buffering.maxProgressDriftPct, 2) ?? null,
  };
}

function buildSummary(raw: RawBench) {
  const git = gitInfo();
  const impls: Record<string, unknown> = {};
  const calibrationImpls: Record<string, unknown> = {};

  for (const [id, impl] of Object.entries(raw.impls ?? {})) {
    const intervalUs = impl.calibration?.intervalUs ?? 0;
    const configs: Record<string, unknown> = {};
    let noiseMaxSamples = 0;

    for (const [configId, config] of Object.entries(impl.configs ?? {})) {
      noiseMaxSamples = Math.max(noiseMaxSamples, config.noiseUs?.max ?? 0);
      configs[configId] = summarizeConfig(config, intervalUs);
    }

    calibrationImpls[id] = {
      effectiveIntervalUs: round(intervalUs) ?? null,
      burnMs: impl.calibration?.burnMs ?? null,
      runs: impl.calibration?.runs?.length ?? 0,
      noiseFloor: {
        maxSamples: noiseMaxSamples,
        // Con 0 muestras de ruido, la cota es "< 1 muestra".
        boundUs: noiseMaxSamples === 0 ? round(intervalUs) : round(noiseMaxSamples * intervalUs),
        note:
          noiseMaxSamples === 0
            ? "p50=p95=max=0 muestras en todas las configuraciones: ruido < 1 muestra"
            : "ruido medido en muestras; multiplicar por effectiveIntervalUs",
      },
    };

    impls[id] = {
      configs,
      memory: (impl.memory ?? []).map(summarizeMemory),
    };
  }

  return {
    schema: "proxy-cpu/bench-summary@1",
    generatedBy: {
      script: "spikes/proxy-cpu/scripts/summarize.ts",
      source: SOURCE_PATH,
      headAtGeneration: git.head,
      headSubject: git.subject,
      generatedAt: new Date().toISOString(),
    },
    run: raw.meta ?? {},
    notes: [
      `${SOURCE_PATH} está gitignored porque contiene traces por chunk, muestras de heap y frames de CPU; este fichero solo agrega las métricas que cita RESULT.md.`,
      "CPU cuantizada: nonIdleSamples son conteos enteros de muestras; cpuUs = conteo × intervalUs y upperBoundUs = max × intervalUs.",
      "usedSize viene de Runtime.getHeapUsage (heap JS del isolate) durante una subida dedicada; no es RSS. El RSS se incluye solo como cota superior.",
      "La sonda de memoria es por implementación, no por configuración: ver impls.<id>.memory.",
      "Regenerar: `bun scripts/summarize.ts`; bench.ts lo reescribe al final de cada corrida.",
    ],
    calibration: {
      requestedIntervalUs: REQUESTED_INTERVAL_US,
      impls: calibrationImpls,
    },
    impls,
  };
}

export async function writeSummary(): Promise<string> {
  const source = Bun.file(SOURCE_PATH);
  if (!(await source.exists())) {
    throw new Error(`no existe ${SOURCE_PATH}; corre \`bun run bench\` primero`);
  }
  const raw = (await source.json()) as RawBench;
  const summary = buildSummary(raw);
  await Bun.write(OUTPUT_PATH, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`[summary] ${OUTPUT_PATH} (${Object.keys(summary.impls).length} implementaciones)`);
  return OUTPUT_PATH;
}

if (import.meta.main) await writeSummary();
