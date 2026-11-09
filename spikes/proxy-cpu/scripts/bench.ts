/**
 * Orquestador del spike: arranca el sink, arranca `wrangler dev` para cada
 * implementación (minimal / elysia / elysia-schema), mide CPU por CDP, prueba
 * buffering con throttle, escalado por tamaño y por chunk, y errores 413/500.
 *
 *   bun scripts/bench.ts                 # matriz completa
 *   bun scripts/bench.ts --only minimal  # una implementación
 *   bun scripts/bench.ts --quick         # 5 requests por config (smoke test)
 *
 * Resultados crudos: results/bench.json (gitignored). Las tablas de RESULT.md
 * salen de ese fichero.
 */
import { getActiveRun, getLastRun, resetSink, startSink } from "./sink";
import {
  calibrate,
  measureBatch,
  sampleMemoryDuringUpload,
  stats,
  type BatchResult,
  type CalibrationResult,
  type MeasuredRequest,
  type MemoryProbeResult,
} from "./measure-cpu";
import { uploadOnce, type UploadOptions, type UploadResult } from "./upload";
import { writeSummary } from "./summarize";

const MB = 1_000_000;

interface ImplDef {
  id: string;
  config: string;
  port: number;
  inspector: number;
  /** configs de la matriz que se ejecutan para esta implementación */
  configs?: string[];
}

const IMPLS: ImplDef[] = [
  { id: "minimal", config: "wrangler.jsonc", port: 8807, inspector: 9240 },
  { id: "elysia", config: "wrangler.elysia.jsonc", port: 8810, inspector: 9241 },
  {
    id: "elysia-schema",
    config: "wrangler.elysia-schema.jsonc",
    port: 8812,
    inspector: 9242,
    // Variante de control: si el schema consume el body, la matriz completa es
    // lenta y no aporta nada. Solo se mide el caso headline y octet-stream.
    configs: ["headline-20mb", "octet-20mb"],
  },
];

const SINK_PORT = 8798;

interface RunConfig {
  id: string;
  sizeMb: number;
  chunkKb: number;
  rateMb: number;
  multipart: boolean;
  status: number;
  repeat: number;
  reps: number;
  idleWindows: number;
  /** solo para la prueba de abort */
  abortAfterMs?: number;
}

interface BufferingMetrics {
  shaMatch: boolean;
  bytesMatch: boolean;
  sentBytes: number;
  receivedBytes: number;
  sentSha256: string;
  receivedSha256: string;
  firstByteDelayMs: number;
  lastByteDelayMs: number;
  uploadSpanMs: number;
  sinkSpanMs: number;
  maxGapMs: number;
  sinkChunkCount: number;
  clientChunkCount: number;
  maxProgressDriftPct: number;
  status: number;
  responseHeaders: Record<string, string>;
  responseContentType: string | null;
  responseContentLength: string | null;
  upstreamStatusEcho: number | null;
  receivedContentLength: string | null;
  receivedTransferEncoding: string | null;
  aborted: boolean;
  /** el cliente cortó la subida (socket destruido) */
  clientAborted: boolean;
  /** el sink terminó de leer el cuerpo y respondió */
  sinkCompleted: boolean;
}

interface ConfigResult {
  config: RunConfig;
  requests: number;
  /** estimador por conteo de muestras (headline) */
  cpuUs: ReturnType<typeof stats>;
  /** regla prescrita (suma de timeDeltas), sesgada por muestreo disperso */
  cpuDeltaUs: ReturnType<typeof stats>;
  nonIdleSamples: ReturnType<typeof stats>;
  intervalUs: number;
  meanCpuUs: number;
  noiseUs: ReturnType<typeof stats>;
  wallMs: ReturnType<typeof stats>;
  cpuPerMbUs: number;
  cpuPerChunkUs: number;
  /** cota superior a partir de p95 muestras × intervalo / tamaño */
  cpuPerMbUpperUs: number;
  cpuPerChunkUpperUs: number;
  cpuPerRequestP50Us: number;
  statuses: Record<string, number>;
  perRepCpuUs: ReturnType<typeof stats>[];
  perRepNoiseUs: ReturnType<typeof stats>[];
  perRequestCpuUs: number[];
  topFrames: { name: string; url: string; us: number }[];
  processCpuUsPerRequest: number | null;
  notes: string[];
  buffering: BufferingMetrics | null;
}

interface ImplResult {
  impl: ImplDef;
  configs: Record<string, ConfigResult>;
  calibration: CalibrationResult | null;
  /** heap/RSS medidos con una subida dedicada (20 y 50 MB) */
  memory: MemoryRun[];
  workerLogTail: string[];
}

interface MemoryRun extends MemoryProbeResult {
  processRss: {
    before: ProcessMemory | null;
    after: ProcessMemory | null;
  };
}

function parseSinkRun(upload: UploadResult): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(upload.body) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Deriva del sink + cliente las métricas de buffering de una corrida. */
function bufferingMetrics(upload: UploadResult): BufferingMetrics {
  const sink = parseSinkRun(upload);
  const chunks = Array.isArray(sink?.["chunks"])
    ? (sink["chunks"] as { dtMs: number; bytes: number }[])
    : [];
  const firstChunkAt = num(sink?.["firstChunkAt"]) ?? 0;
  const lastChunkAt = num(sink?.["lastChunkAt"]) ?? 0;
  const receivedBytes = num(sink?.["totalBytes"]) ?? 0;
  const receivedSha = typeof sink?.["sha256"] === "string" ? sink["sha256"] : "";

  const firstByteDelayMs =
    firstChunkAt > 0 && upload.firstWriteAt > 0 ? firstChunkAt - upload.firstWriteAt : -1;
  const lastByteDelayMs =
    lastChunkAt > 0 && upload.lastWriteAt > 0 ? lastChunkAt - upload.lastWriteAt : -1;

  const drift = progressDriftPct(upload, chunks, firstChunkAt);

  return {
    shaMatch: receivedSha === upload.sentSha256,
    bytesMatch: receivedBytes === upload.sentBytes,
    sentBytes: upload.sentBytes,
    receivedBytes,
    sentSha256: upload.sentSha256,
    receivedSha256: receivedSha,
    firstByteDelayMs,
    lastByteDelayMs,
    uploadSpanMs: Math.max(0, upload.lastWriteAt - upload.firstWriteAt),
    sinkSpanMs: num(sink?.["bodySpanMs"]) ?? 0,
    maxGapMs: num(sink?.["maxGapMs"]) ?? 0,
    sinkChunkCount: chunks.length,
    clientChunkCount: upload.sendTimeline.length,
    maxProgressDriftPct: drift,
    status: upload.status,
    responseHeaders: upload.headers,
    responseContentType: upload.headers["content-type"] ?? null,
    responseContentLength: upload.headers["content-length"] ?? null,
    upstreamStatusEcho: num(sink?.["status"]),
    receivedContentLength:
      typeof sink?.["receivedContentLength"] === "string"
        ? (sink["receivedContentLength"] as string)
        : null,
    receivedTransferEncoding:
      typeof sink?.["receivedTransferEncoding"] === "string"
        ? (sink["receivedTransferEncoding"] as string)
        : null,
    aborted: sink?.["aborted"] === true,
    clientAborted: upload.abortedByClient,
    sinkCompleted: upload.status !== 0,
  };
}

/**
 * Deriva temporal del perfil de llegada frente al de envío, en puntos porcentuales:
 * normaliza ambos ejes de tiempo a [0,1] y compara la fracción acumulada de bytes.
 * Un proxy que bufferea da ~100 % de deriva; uno que streamea, pocos puntos.
 */
function progressDriftPct(
  upload: UploadResult,
  sinkChunks: { dtMs: number; bytes: number }[],
  firstChunkAt: number,
): number {
  if (sinkChunks.length === 0 || upload.sendTimeline.length === 0) return 100;
  const sendT0 = upload.sendTimeline[0]?.t ?? 0;
  const sendT1 = upload.lastWriteAt;
  const sendSpan = Math.max(1, sendT1 - sendT0);

  const sinkT0 = firstChunkAt;
  const lastChunk = sinkChunks[sinkChunks.length - 1];
  const sinkT1 = sinkT0 + (lastChunk?.dtMs ?? 0);
  const sinkSpan = Math.max(1, sinkT1 - sinkT0);

  const sendPoints: { u: number; fraction: number }[] = [];
  let sendCum = 0;
  for (const entry of upload.sendTimeline) {
    sendCum += entry.bytes;
    sendPoints.push({ u: (entry.t - sendT0) / sendSpan, fraction: sendCum / upload.sentBytes });
  }

  const fractionAt = (u: number): number => {
    if (sendPoints.length === 0) return 0;
    let previous = sendPoints[0]!;
    for (const point of sendPoints) {
      if (point.u >= u) {
        if (point.u === previous.u) return point.fraction;
        const ratio = (u - previous.u) / (point.u - previous.u);
        return previous.fraction + (point.fraction - previous.fraction) * ratio;
      }
      previous = point;
    }
    return previous.fraction;
  };

  let sinkCum = 0;
  let maxDrift = 0;
  const total = sinkChunks.reduce((acc, chunk) => acc + chunk.bytes, 0);
  if (total === 0) return 100;
  for (const chunk of sinkChunks) {
    sinkCum += chunk.bytes;
    const u = chunk.dtMs / sinkSpan;
    const expected = fractionAt(u);
    const actual = sinkCum / total;
    maxDrift = Math.max(maxDrift, Math.abs(actual - expected) * 100);
  }
  return Math.round(maxDrift * 100) / 100;
}

async function portInUse(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(500),
    });
    await response.text();
    return true;
  } catch {
    return false;
  }
}

async function readHealth(port: number, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const text = await response.text();
      if (response.ok && text.trim() === "ok") return;
      lastError = `HTTP ${response.status} body=${text.slice(0, 40)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(250);
  }
  throw new Error(`worker en :${port} no respondió (${lastError})`);
}

interface WorkerHandle {
  impl: ImplDef;
  child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  logTail: string[];
  pid: number;
  stop: () => Promise<void>;
}

async function startWorker(impl: ImplDef): Promise<WorkerHandle> {
  if (await portInUse(impl.port)) {
    throw new Error(
      `${impl.id}: el puerto ${impl.port} ya está ocupado por otro proceso; ` +
        "el spike no mata procesos ajenos (ver RESULT.md §Entorno)",
    );
  }
  const logTail: string[] = [];
  const child = Bun.spawn(
    [
      "node",
      "node_modules/wrangler/bin/wrangler.js",
      "dev",
      "-c",
      impl.config,
      "--port",
      String(impl.port),
      "--inspector-port",
      String(impl.inspector),
      "--ip",
      "127.0.0.1",
      "--inspector-ip",
      "127.0.0.1",
      "--local",
      "--show-interactive-dev-session=false",
    ],
    {
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
        WRANGLER_SEND_METRICS: "false",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const consume = async (
    stream: ReadableStream<Uint8Array>,
    prefix: string,
  ): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === "") continue;
        logTail.push(`${prefix}${line}`);
        if (logTail.length > 400) logTail.shift();
      }
    }
  };
  void consume(child.stdout, "");
  void consume(child.stderr, "");

  const stop = async (): Promise<void> => {
    try {
      Bun.spawnSync(["taskkill", "/PID", String(child.pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {
      // ignore
    }
    try {
      await child.exited;
    } catch {
      // ignore
    }
    await Bun.sleep(400);
  };

  try {
    await readHealth(impl.port);
  } catch (error) {
    await stop();
    throw new Error(
      `${impl.id}: ${error instanceof Error ? error.message : String(error)}\n${logTail.join("\n")}`,
    );
  }

  return { impl, child, logTail, pid: child.pid, stop };
}

/**
 * CPU de proceso (cota superior burda) de TODO el árbol de procesos del
 * `wrangler dev` que hemos arrancado (node → wrangler → workerd). Incluye hilos
 * nativos y el propio profiler, por eso es una cota superior, no la métrica.
 */
function processTreeCpuMs(rootPid: number): number | null {
  const script = `
$root = ${rootPid}
$procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$ids = New-Object System.Collections.Generic.HashSet[int]
[void]$ids.Add($root)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $procs) {
    if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
      [void]$ids.Add([int]$p.ProcessId)
      $changed = $true
    }
  }
}
$sum = 0.0
foreach ($id in $ids) {
  $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($proc) { $sum += $proc.TotalProcessorTime.TotalMilliseconds }
}
$sum
`;
  try {
    const result = Bun.spawnSync(
      ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
      { stdout: "pipe", stderr: "ignore" },
    );
    const text = result.stdout.toString().trim();
    const value = Number(text);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return null;
  }
}

interface ProcessMemory {
  workingSetBytes: number;
  peakWorkingSetBytes: number;
  processCount: number;
}

/**
 * RSS del árbol de procesos (node → wrangler → workerd), antes y después de una
 * subida. Incluye runtime + isolate + inspector + dev server, por eso es una
 * cota superior y no el heap del Worker.
 */
function processMemory(rootPid: number): ProcessMemory | null {
  const script = `
$root = ${rootPid}
$procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$ids = New-Object System.Collections.Generic.HashSet[int]
[void]$ids.Add($root)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $procs) {
    if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
      [void]$ids.Add([int]$p.ProcessId)
      $changed = $true
    }
  }
}
$ws = 0.0
$peak = 0.0
$n = 0
foreach ($id in $ids) {
  $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($proc) { $ws += $proc.WorkingSet64; $peak += $proc.PeakWorkingSet64; $n++ }
}
"$ws|$peak|$n"
`;
  try {
    const result = Bun.spawnSync(
      ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
      { stdout: "pipe", stderr: "ignore" },
    );
    const [ws, peak, count] = result.stdout.toString().trim().split("|");
    const workingSetBytes = Number(ws);
    const peakWorkingSetBytes = Number(peak);
    const processCount = Number(count);
    if (!Number.isFinite(workingSetBytes) || !Number.isFinite(peakWorkingSetBytes)) {
      return null;
    }
    return { workingSetBytes, peakWorkingSetBytes, processCount };
  } catch {
    return null;
  }
}

function aggregateTopFrames(requests: MeasuredRequest[]): { name: string; url: string; us: number }[] {
  const map = new Map<string, { name: string; url: string; us: number }>();
  for (const request of requests) {
    for (const frame of request.cpu.topFrames) {
      const key = `${frame.name}|${frame.url}`;
      const entry = map.get(key) ?? { name: frame.name, url: frame.url, us: 0 };
      entry.us += frame.us;
      map.set(key, entry);
    }
  }
  return [...map.values()].sort((a, b) => b.us - a.us).slice(0, 10);
}

function buildConfigResult(
  config: RunConfig,
  batches: BatchResult[],
  processCpuUsPerRequest: number | null,
): ConfigResult {
  const allRequests = batches.flatMap((batch) => batch.requests);
  const estimateValues = allRequests.map((request) => request.cpu.cpuEstimateUs);
  const deltaValues = allRequests.map((request) => request.cpu.cpuUs);
  const sampleValues = allRequests.map((request) => request.cpu.nonIdleSamples);
  const wallValues = allRequests.map((request) => request.cpu.wallUs);
  const noiseValues = batches.flatMap((batch) =>
    batch.idleWindows.map((window) => window.cpu.cpuEstimateUs),
  );
  const intervalUs = batches[0]?.intervalUs ?? 0;
  const statuses: Record<string, number> = {};
  for (const request of allRequests) {
    const key = String(request.upload.status);
    statuses[key] = (statuses[key] ?? 0) + 1;
  }

  const wireBytes = allRequests[0]?.upload.wireBytes ?? config.sizeMb * MB;
  const chunks = Math.max(1, Math.ceil(wireBytes / (config.chunkKb * 1024)));
  const estimateStats = stats(estimateValues);
  const meanCpuUs = estimateStats.mean;

  return {
    config,
    requests: allRequests.length,
    cpuUs: estimateStats,
    cpuDeltaUs: stats(deltaValues),
    nonIdleSamples: stats(sampleValues),
    intervalUs: Math.round(intervalUs * 1000) / 1000,
    meanCpuUs: Math.round(meanCpuUs * 1000) / 1000,
    noiseUs: stats(noiseValues),
    wallMs: {
      ...stats(wallValues.map((value) => value / 1000)),
      n: wallValues.length,
    },
    cpuPerMbUs: config.sizeMb > 0 ? Math.round((meanCpuUs / config.sizeMb) * 1000) / 1000 : 0,
    cpuPerChunkUs: Math.round((meanCpuUs / chunks) * 1000) / 1000,
    // Cota superior: usa el p95 de muestras (cuantizado) en vez de la media.
    cpuPerMbUpperUs:
      config.sizeMb > 0
        ? Math.round((estimateStats.p95 / config.sizeMb) * 1000) / 1000
        : 0,
    cpuPerChunkUpperUs: Math.round((estimateStats.p95 / chunks) * 1000) / 1000,
    cpuPerRequestP50Us: Math.round(estimateStats.p50 * 1000) / 1000,
    statuses,
    perRepCpuUs: batches.map((batch) =>
      stats(batch.requests.map((request) => request.cpu.cpuEstimateUs)),
    ),
    perRepNoiseUs: batches.map((batch) =>
      stats(batch.idleWindows.map((window) => window.cpu.cpuEstimateUs)),
    ),
    perRequestCpuUs: estimateValues.map((value) => Math.round(value * 1000) / 1000),
    topFrames: aggregateTopFrames(allRequests),
    processCpuUsPerRequest,
    notes: batches.flatMap((batch) => batch.notes),
    buffering: allRequests[0] === undefined ? null : bufferingMetrics(allRequests[0].upload),
  };
}

async function runConfig(
  worker: WorkerHandle,
  config: RunConfig,
  uploadUrl: string,
  intervalUs: number,
): Promise<ConfigResult> {
  const batches: BatchResult[] = [];
  const cpuBefore = processTreeCpuMs(worker.pid);

  for (let rep = 0; rep < config.reps; rep++) {
    const upload: UploadOptions = {
      url: uploadUrl,
      sizeBytes: Math.round(config.sizeMb * MB),
      chunkBytes: Math.round(config.chunkKb * 1024),
      rateBytesPerSec: config.rateMb > 0 ? Math.round(config.rateMb * MB) : 0,
      multipart: config.multipart,
      headers:
        config.status === 200 ? undefined : { "x-sink-status": String(config.status) },
    };
    const batch = await measureBatch({
      inspectorPort: worker.impl.inspector,
      upload,
      repeat: config.repeat,
      idleWindows: rep === 0 ? config.idleWindows : 0,
      settleMs: 30,
      intervalUs,
    });
    batches.push(batch);
    const statusSet = new Set(batch.requests.map((request) => request.upload.status));
    console.log(
      `    rep ${rep + 1}/${config.reps}: ${batch.requests.length} req, status ${[...statusSet].join(",")}, ` +
        `cpu p50 ${stats(batch.requests.map((r) => r.cpu.cpuEstimateUs)).p50.toFixed(0)} µs, ` +
        `noise p50 ${stats(batch.idleWindows.map((w) => w.cpu.cpuEstimateUs)).p50.toFixed(0)} µs`,
    );
  }

  const cpuAfter = processTreeCpuMs(worker.pid);
  const totalRequests = config.repeat * config.reps;
  const processCpuUsPerRequest =
    cpuBefore === null || cpuAfter === null
      ? null
      : Math.round(((cpuAfter - cpuBefore) * 1000) / totalRequests);

  return buildConfigResult(config, batches, processCpuUsPerRequest);
}

/**
 * Mide heap del isolate + RSS del proceso durante UNA subida dedicada.
 * La subida se throttlea para poder muestrear el stream (2 MB/s a 20 MB,
 * 5 MB/s a 50 MB → ~10 s en ambos casos).
 */
async function runMemoryProbe(
  worker: WorkerHandle,
  sizeMb: number,
  rateMb: number,
): Promise<MemoryRun> {
  const before = processMemory(worker.pid);
  const probe = await sampleMemoryDuringUpload({
    inspectorPort: worker.impl.inspector,
    upload: {
      url: `http://127.0.0.1:${worker.impl.port}/proxy`,
      sizeBytes: Math.round(sizeMb * MB),
      chunkBytes: 1024 * 1024,
      rateBytesPerSec: Math.round(rateMb * MB),
      multipart: true,
    },
    sampleIntervalMs: 50,
    settleMs: 500,
  });
  const after = processMemory(worker.pid);
  console.log(
    `    mem ${sizeMb} MB: heap pico Δ ${probe.peakDeltaBytes ?? "n/a"} B ` +
      `(${probe.sampleCount} muestras), RSS Δ ${
        before !== null && after !== null
          ? after.workingSetBytes - before.workingSetBytes
          : "n/a"
      } B`,
  );
  return { ...probe, processRss: { before, after } };
}

/** Corre una subida (o varias) sin perfilado: buffering / errores / abort. */
async function runRaw(
  config: RunConfig,
  uploadUrl: string,
): Promise<BufferingMetrics[]> {
  const results: BufferingMetrics[] = [];
  for (let i = 0; i < config.reps; i++) {
    const upload = await uploadOnce({
      url: uploadUrl,
      sizeBytes: Math.round(config.sizeMb * MB),
      chunkBytes: Math.round(config.chunkKb * 1024),
      rateBytesPerSec: config.rateMb > 0 ? Math.round(config.rateMb * MB) : 0,
      multipart: config.multipart,
      headers:
        config.status === 200 ? undefined : { "x-sink-status": String(config.status) },
      abortAfterMs: config.abortAfterMs,
    });
    results.push(bufferingMetrics(upload));
    console.log(
      `    raw ${i + 1}/${config.reps}: status ${upload.status}, ` +
        `sent ${upload.sentBytes} B, recv ${results[i]?.receivedBytes ?? 0} B, ` +
        `firstByte ${results[i]?.firstByteDelayMs ?? -1} ms, ` +
        `sha ${results[i]?.shaMatch ? "OK" : "MISMATCH"}`,
    );
  }
  return results;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const onlyIndex = args.indexOf("--only");
  const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;
  const configsIndex = args.indexOf("--configs");
  const onlyConfigs =
    configsIndex >= 0 && args[configsIndex + 1] !== undefined
      ? args[configsIndex + 1]!.split(",").map((value) => value.trim())
      : undefined;
  const quick = args.includes("--quick");
  const merge = args.includes("--merge");
  const repeat = quick ? 5 : 20;
  const reps = quick ? 1 : 3;
  const idleWindows = quick ? 5 : 20;

  const sink = startSink(SINK_PORT);
  console.log(`[bench] sink en http://127.0.0.1:${sink.port}/sink`);

  const selected = IMPLS.filter((impl) => only === undefined || impl.id === only);
  if (selected.length === 0) {
    console.error(`[bench] implementación desconocida: ${only}`);
    process.exit(1);
  }

  const results: Record<string, ImplResult> = {};

  for (const impl of selected) {
    console.log(`\n[bench] === ${impl.id} (${impl.config}, :${impl.port}) ===`);
    const worker = await startWorker(impl);
    try {
      const uploadUrl = `http://127.0.0.1:${impl.port}/proxy`;
      const configs: Record<string, ConfigResult> = {};
      const calibration = await calibrate({
        inspectorPort: impl.inspector,
        url: `http://127.0.0.1:${impl.port}/burn?ms=200`,
        burnMs: 200,
      });
      console.log(
        `  calibración: ${calibration.runs.length} burns de 200 ms → ` +
          `${calibration.intervalUs.toFixed(1)} µs/muestra`,
      );

      const configsToRun: RunConfig[] = [
        {
          id: "headline-20mb",
          sizeMb: 20,
          chunkKb: 1024,
          rateMb: 0,
          multipart: true,
          status: 200,
          repeat,
          reps,
          idleWindows,
        },
        {
          id: "scale-1mb",
          sizeMb: 1,
          chunkKb: 1024,
          rateMb: 0,
          multipart: true,
          status: 200,
          repeat,
          reps,
          idleWindows,
        },
        {
          id: "scale-5mb",
          sizeMb: 5,
          chunkKb: 1024,
          rateMb: 0,
          multipart: true,
          status: 200,
          repeat,
          reps,
          idleWindows,
        },
        {
          // Tamaño real de un chunk de 30 min (~5,4 MB).
          id: "scale-5.4mb",
          sizeMb: 5.4,
          chunkKb: 1024,
          rateMb: 0,
          multipart: true,
          status: 200,
          repeat,
          reps,
          idleWindows,
        },
        {
          // Tamaño real de 1 h (~11,9 MB).
          id: "scale-11.9mb",
          sizeMb: 11.9,
          chunkKb: 1024,
          rateMb: 0,
          multipart: true,
          status: 200,
          repeat,
          reps,
          idleWindows,
        },
        {
          id: "scale-50mb",
          sizeMb: 50,
          chunkKb: 1024,
          rateMb: 0,
          multipart: true,
          status: 200,
          repeat,
          reps,
          idleWindows,
        },
        {
          id: "chunk-64kb",
          sizeMb: 20,
          chunkKb: 64,
          rateMb: 0,
          multipart: true,
          status: 200,
          repeat,
          reps,
          idleWindows,
        },
        {
          id: "chunk-4mb",
          sizeMb: 20,
          chunkKb: 4096,
          rateMb: 0,
          multipart: true,
          status: 200,
          repeat,
          reps,
          idleWindows,
        },
        {
          id: "octet-20mb",
          sizeMb: 20,
          chunkKb: 1024,
          rateMb: 0,
          multipart: false,
          status: 200,
          repeat,
          reps,
          idleWindows,
        },
      ];

      const shouldRun = (id: string): boolean =>
        (impl.configs === undefined || impl.configs.includes(id)) &&
        (onlyConfigs === undefined || onlyConfigs.includes(id));

      for (const config of configsToRun.filter((candidate) => shouldRun(candidate.id))) {
        console.log(`  [${config.id}] ${config.sizeMb} MB / chunk ${config.chunkKb} KB`);
        configs[config.id] = await runConfig(
          worker,
          config,
          uploadUrl,
          calibration.intervalUs,
        );
      }

      // Errores: 413 y 500 (cuerpo de 1 MB, rápido).
      for (const status of [413, 500]) {
        if (!shouldRun(`error-${status}`)) continue;
        const config: RunConfig = {
          id: `error-${status}`,
          sizeMb: 1,
          chunkKb: 1024,
          rateMb: 0,
          multipart: true,
          status,
          repeat: 1,
          reps: 3,
          idleWindows: 0,
        };
        console.log(`  [${config.id}] propagación de ${status}`);
        const metrics = await runRaw(config, uploadUrl);
        configs[config.id] = {
          ...buildConfigResult(config, [], null),
          requests: metrics.length,
          buffering: metrics[0] ?? null,
          statuses: metrics.reduce<Record<string, number>>((acc, metric) => {
            acc[String(metric.status)] = (acc[String(metric.status)] ?? 0) + 1;
            return acc;
          }, {}),
        };
      }

      // Buffering con throttle (~2 MB/s durante ~10 s).
      if (shouldRun("throttled-20mb")) {
        const config: RunConfig = {
          id: "throttled-20mb",
          sizeMb: 20,
          chunkKb: 1024,
          rateMb: 2,
          multipart: true,
          status: 200,
          repeat: 1,
          reps: 3,
          idleWindows: 0,
        };
        console.log("  [throttled-20mb] 20 MB a ~2 MB/s (perfil de llegada al sink)");
        const metrics = await runRaw(config, uploadUrl);
        configs[config.id] = {
          ...buildConfigResult(config, [], null),
          requests: metrics.length,
          buffering: metrics[0] ?? null,
          statuses: metrics.reduce<Record<string, number>>((acc, metric) => {
            acc[String(metric.status)] = (acc[String(metric.status)] ?? 0) + 1;
            return acc;
          }, {}),
        };
      }

      // Abort del cliente a mitad de subida (R6).
      if (shouldRun("client-abort")) {
        const config: RunConfig = {
          id: "client-abort",
          sizeMb: 20,
          chunkKb: 1024,
          rateMb: 2,
          multipart: true,
          status: 200,
          repeat: 1,
          reps: 1,
          idleWindows: 0,
          abortAfterMs: 1500,
        };
        console.log("  [client-abort] abort a los 1500 ms de una subida de 20 MB");
        resetSink();
        const metrics = await runRaw(config, uploadUrl);
        const sinkRun = getLastRun();
        const active = getActiveRun();
        const aborted = metrics[0];
        if (sinkRun !== null && aborted !== undefined) {
          aborted.aborted = sinkRun.aborted;
          aborted.receivedBytes = sinkRun.totalBytes;
          aborted.sinkChunkCount = sinkRun.chunkCount;
          aborted.receivedTransferEncoding = sinkRun.receivedTransferEncoding;
          aborted.maxGapMs = sinkRun.maxGapMs;
          aborted.sinkSpanMs = sinkRun.bodySpanMs;
          aborted.sinkCompleted = true;
          console.log(
            `    sink tras abort: ${sinkRun.totalBytes} B, ${sinkRun.chunkCount} chunks, ` +
              `aborted=${sinkRun.aborted}, readError=${sinkRun.readError ?? "-"}`,
          );
        } else if (active !== null && aborted !== undefined) {
          // El sink Bun no propaga el corte del socket: el run queda abierto.
          // La prueba con upstream Node (scripts/sink-node.cjs) sí lo detecta.
          aborted.receivedBytes = active.totalBytes;
          aborted.sinkChunkCount = active.chunkCount;
          aborted.aborted = active.aborted;
          aborted.sinkCompleted = false;
          console.log(
            `    sink tras abort: run ABIERTO con ${active.totalBytes} B / ${active.chunkCount} chunks ` +
              `(el sink Bun no ve el cierre del socket; ver sink-node.cjs)`,
          );
        } else {
          console.log("    sink tras abort: sin run (el abort no llegó al upstream)");
        }
        configs[config.id] = {
          ...buildConfigResult(config, [], null),
          requests: metrics.length,
          buffering: metrics[0] ?? null,
        };
        configs[config.id]?.notes.push(
          active !== null
            ? "abort: el sink Bun no cierra el run; la prueba con upstream Node sí detecta ABORTED/complete=false"
            : "abort: el sink completó el run",
        );
      }

      // Memoria: una subida dedicada por tamaño, con el stream muestreado.
      // Se omite en el control negativo (siempre 500/0 B) y en --quick.
      const memory: MemoryRun[] = [];
      if (!quick && impl.id !== "elysia-schema") {
        for (const sizeMb of [20, 50]) {
          const rateMb = sizeMb >= 50 ? 5 : 2;
          console.log(
            `  [mem-${sizeMb}mb] heap/RSS durante una subida a ${rateMb} MB/s`,
          );
          memory.push(await runMemoryProbe(worker, sizeMb, rateMb));
        }
      }

      results[impl.id] = {
        impl,
        configs,
        calibration,
        memory,
        workerLogTail: worker.logTail.slice(-30),
      };
    } finally {
      await worker.stop();
    }
  }

  const meta = {
    startedAt: new Date().toISOString(),
    host: process.env["COMPUTERNAME"] ?? "unknown",
    platform: process.platform,
    bun: Bun.version,
    repeat,
    reps,
    idleWindows,
    sinkPort: SINK_PORT,
    note: "CPU medida por CDP en workerd local; wrangler dev NO aplica el límite de 10 ms",
  };

  let output: { meta: typeof meta & { mergedAt?: string }; impls: Record<string, ImplResult> } = {
    meta,
    impls: results,
  };

  if (merge && (await Bun.file("results/bench.json").exists())) {
    const existing = (await Bun.file("results/bench.json").json()) as typeof output;
    output = {
      meta: { ...existing.meta, ...meta, mergedAt: new Date().toISOString() },
      impls: { ...existing.impls },
    };
    for (const [id, result] of Object.entries(results)) {
      const previous = output.impls[id];
      output.impls[id] = {
        ...previous,
        ...result,
        configs: { ...(previous?.configs ?? {}), ...result.configs },
        // Conserva la calibración original de la ronda 0; los configs nuevos
        // guardan sus valores ya calculados con la calibración de esta corrida.
        calibration: previous?.calibration ?? result.calibration,
        memory: result.memory ?? previous?.memory ?? [],
        workerLogTail: result.workerLogTail,
      };
    }
    console.log("[bench] resultados fusionados en results/bench.json (--merge)");
  }

  await Bun.write("results/bench.json", JSON.stringify(output, null, 2));
  console.log("\n[bench] resultados en results/bench.json");
  // Resumen agregado y versionado (results/bench.json está gitignored).
  await writeSummary();
  sink.stop(true);
}

await main();
