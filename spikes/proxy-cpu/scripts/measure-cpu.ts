/**
 * Medición de CPU por request vía CDP (Chrome DevTools Protocol) contra el
 * inspector de `wrangler dev` (workerd).
 *
 *   bun scripts/measure-cpu.ts --inspector 9240 --url http://127.0.0.1:8807/proxy \
 *       --size 20 --chunk 1024 --multipart --repeat 20
 *
 * Método (documentado en RESULT.md):
 *   1. `Profiler.enable` + `Profiler.setSamplingInterval(100 µs)`.
 *   2. Por request: `Profiler.start` → subida completa → `Profiler.stop`.
 *   3. Se publican DOS números:
 *      - `cpuUs`: suma de `timeDeltas` de las muestras no-`(idle)`/no-`(program)`
 *        (método prescrito en R3; se conserva por transparencia).
 *      - `cpuEstimateUs`: `nonIdleSamples × intervaloCalibrado`. Es el estimador
 *        que usan las tablas: workerd solo emite muestras cuando ejecuta JS, así
 *        que `timeDeltas` mide huecos de pared y sobreestima (ver RESULT.md §3).
 *   4. Ruido: N ventanas idle de la misma duración (mediana de la tanda) medidas
 *      con el mismo método; se publica p50/p95/máx.
 */
import { uploadOnce, type UploadOptions, type UploadResult } from "./upload";

interface ProfileNode {
  id: number;
  callFrame: {
    functionName: string;
    url: string;
    lineNumber: number;
  };
  hitCount?: number;
}

export interface Profile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

export interface CpuSummary {
  /** wall de la ventana del profiler (µs) */
  wallUs: number;
  /** CPU atribuido a JS (µs): ni (idle) ni (program) — regla prescrita en R3 */
  cpuUs: number;
  /** estimación por conteo de muestras: nonIdleSamples × intervalo calibrado */
  cpuEstimateUs: number;
  idleUs: number;
  programUs: number;
  gcUs: number;
  /** muestras no-idle/no-program (cada una vale ~1 intervalo de CPU) */
  nonIdleSamples: number;
  gcSamples: number;
  /** suma de timeDeltas (control de consistencia con wallUs) */
  deltaSumUs: number;
  sampleCount: number;
  topFrames: { name: string; url: string; us: number; samples: number }[];
}

export class CdpClient {
  private readonly ws: WebSocket;
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  static async connect(wsUrl: string, timeoutMs = 10_000): Promise<CdpClient> {
    const ws = new WebSocket(wsUrl);
    const client = new CdpClient(ws);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`timeout conectando a ${wsUrl}`));
        }
      }, timeoutMs);
      ws.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", (event) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`error de WebSocket: ${String(event)}`));
      });
    });
    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      let message: {
        id?: number;
        result?: unknown;
        error?: { message?: string; code?: number };
      };
      try {
        message = JSON.parse(raw) as typeof message;
      } catch {
        return;
      }
      if (message.id === undefined) return;
      const entry = client.pending.get(message.id);
      if (entry === undefined) return;
      client.pending.delete(message.id);
      if (message.error !== undefined) {
        entry.reject(new Error(message.error.message ?? "CDP error"));
      } else {
        entry.resolve(message.result);
      }
    });
    return client;
  }

  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

/** Descubre el WebSocket del inspector de workerd vía /json/list. */
export async function discoverInspector(
  inspectorPort: number,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${inspectorPort}/json/list`);
      if (response.ok) {
        const targets = (await response.json()) as {
          webSocketDebuggerUrl?: string;
          url?: string;
          title?: string;
        }[];
        const target = targets.find(
          (candidate) =>
            typeof candidate.webSocketDebuggerUrl === "string" &&
            candidate.webSocketDebuggerUrl.length > 0,
        );
        if (target?.webSocketDebuggerUrl !== undefined) {
          // workerd puede anunciar 0.0.0.0; forzamos loopback.
          return target.webSocketDebuggerUrl.replace("://0.0.0.0", "://127.0.0.1");
        }
        lastError = `sin webSocketDebuggerUrl en ${targets.length} targets`;
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(250);
  }
  throw new Error(
    `no se encontró el inspector en 127.0.0.1:${inspectorPort} (${lastError})`,
  );
}

export function summarizeProfile(profile: Profile): CpuSummary {
  const nodes = new Map<number, ProfileNode>();
  for (const node of profile.nodes) nodes.set(node.id, node);

  let cpuUs = 0;
  let idleUs = 0;
  let programUs = 0;
  let gcUs = 0;
  let deltaSumUs = 0;
  let nonIdleSamples = 0;
  let gcSamples = 0;
  const perNode = new Map<number, { us: number; samples: number }>();

  for (let i = 0; i < profile.samples.length; i++) {
    const nodeId = profile.samples[i];
    if (nodeId === undefined) continue;
    const delta = profile.timeDeltas[i] ?? 0;
    deltaSumUs += delta;
    const node = nodes.get(nodeId);
    const name = node?.callFrame.functionName ?? "(unknown)";
    if (name === "(idle)") {
      idleUs += delta;
      continue;
    }
    if (name === "(program)") {
      programUs += delta;
      continue;
    }
    cpuUs += delta;
    nonIdleSamples += 1;
    if (name === "(garbage collector)") {
      gcUs += delta;
      gcSamples += 1;
    }
    const entry = perNode.get(nodeId) ?? { us: 0, samples: 0 };
    entry.us += delta;
    entry.samples += 1;
    perNode.set(nodeId, entry);
  }

  const topFrames = [...perNode.entries()]
    .map(([nodeId, entry]) => {
      const node = nodes.get(nodeId);
      return {
        name: node?.callFrame.functionName ?? "(unknown)",
        url: node?.callFrame.url ?? "",
        us: entry.us,
        samples: entry.samples,
      };
    })
    .sort((a, b) => b.us - a.us)
    .slice(0, 8);

  return {
    wallUs: profile.endTime - profile.startTime,
    cpuUs,
    cpuEstimateUs: 0,
    idleUs,
    programUs,
    gcUs,
    nonIdleSamples,
    gcSamples,
    deltaSumUs,
    sampleCount: profile.samples.length,
    topFrames,
  };
}

export interface MeasuredRequest {
  index: number;
  cpu: CpuSummary;
  upload: UploadResult;
  /** CPU neto = cpuUs (el ruido se resta en el análisis, no por request) */
}

export interface IdleWindow {
  index: number;
  cpu: CpuSummary;
}

export interface BatchResult {
  requests: MeasuredRequest[];
  idleWindows: IdleWindow[];
  samplingIntervalUs: number;
  samplingIntervalApplied: boolean;
  /** intervalo real entre muestras del sampler (calibrado con /burn) */
  intervalUs: number;
  notes: string[];
}

export interface MeasureOptions {
  inspectorPort: number;
  upload: Omit<UploadOptions, "url"> & { url: string };
  repeat: number;
  idleWindows: number;
  settleMs: number;
  /** intervalo µs/muestra obtenido con `calibrate()`; 0 = sin calibración */
  intervalUs?: number;
}

export interface CalibrationOptions {
  inspectorPort: number;
  /** endpoint /burn?ms=N del MISMO worker medido */
  url: string;
  burnMs: number;
  runs?: number;
}

export interface CalibrationResult {
  burnMs: number;
  /** µs de CPU por muestra (mediana de las corridas) */
  intervalUs: number;
  runs: CpuSummary[];
}

export interface HeapUsage {
  usedSize: number;
  totalSize: number;
}

export interface MemorySample extends HeapUsage {
  /** ms desde el inicio de la subida */
  tMs: number;
}

export interface MemoryProbeOptions {
  inspectorPort: number;
  upload: Omit<UploadOptions, "url"> & { url: string };
  /** periodo de muestreo de `Runtime.getHeapUsage` */
  sampleIntervalMs?: number;
  /** espera tras completar la subida antes de la lectura final */
  settleMs?: number;
}

/**
 * Muestreo de memoria del isolate durante UNA subida.
 *
 * Expectativa declarada antes de medir: un proxy que no bufferea debe mostrar un
 * delta de heap de pocos MB como máximo con 20 MB; uno que bufferee mostraría
 * ≈ el tamaño del cuerpo. Se lee `Runtime.getHeapUsage` antes, durante (cada
 * `sampleIntervalMs`) y después; `Performance.getMetrics` se guarda como
 * contraste si expone `JSHeapUsedSize`/`JSHeapTotalSize`.
 */
export interface MemoryProbeResult {
  sizeMb: number;
  rateMb: number;
  upload: { status: number; sentBytes: number; wallMs: number; sha256: string };
  baseline: HeapUsage | null;
  peak: HeapUsage | null;
  after: HeapUsage | null;
  peakDeltaBytes: number | null;
  afterDeltaBytes: number | null;
  sampleCount: number;
  samples: MemorySample[];
  performanceBefore: Record<string, number> | null;
  performanceAfter: Record<string, number> | null;
  notes: string[];
}

async function readHeap(client: CdpClient): Promise<HeapUsage> {
  const usage = await client.send<Partial<HeapUsage>>("Runtime.getHeapUsage");
  return { usedSize: usage.usedSize ?? 0, totalSize: usage.totalSize ?? 0 };
}

async function readPerformanceMetrics(
  client: CdpClient,
): Promise<Record<string, number> | null> {
  try {
    const result = await client.send<{ metrics?: { name: string; value: number }[] }>(
      "Performance.getMetrics",
    );
    if (!Array.isArray(result.metrics)) return null;
    const metrics: Record<string, number> = {};
    for (const metric of result.metrics) metrics[metric.name] = metric.value;
    return metrics;
  } catch {
    return null;
  }
}

export async function sampleMemoryDuringUpload(
  options: MemoryProbeOptions,
): Promise<MemoryProbeResult> {
  const notes: string[] = [];
  const sampleIntervalMs = options.sampleIntervalMs ?? 50;
  const settleMs = options.settleMs ?? 500;
  const wsUrl = await discoverInspector(options.inspectorPort);
  const client = await CdpClient.connect(wsUrl);

  try {
    try {
      await client.send("Runtime.enable");
    } catch {
      notes.push("Runtime.enable no soportado; se intenta Runtime.getHeapUsage igualmente");
    }
    let performanceEnabled = true;
    try {
      await client.send("Performance.enable");
    } catch {
      performanceEnabled = false;
      notes.push("Performance.enable no soportado en este workerd");
    }

    const baseline = await readHeap(client);
    const performanceBefore = performanceEnabled
      ? await readPerformanceMetrics(client)
      : null;
    if (performanceBefore === null) {
      notes.push("Performance.getMetrics no devolvió métricas");
    }

    const samples: MemorySample[] = [];
    const startedAt = performance.now();
    let done = false;
    const sampler = (async () => {
      while (!done) {
        await Bun.sleep(sampleIntervalMs);
        if (done) break;
        try {
          const heap = await readHeap(client);
          samples.push({ tMs: Math.round(performance.now() - startedAt), ...heap });
        } catch (error) {
          notes.push(
            `muestreo de heap interrumpido: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          break;
        }
      }
    })();

    let upload: UploadResult;
    try {
      upload = await uploadOnce(options.upload);
    } finally {
      done = true;
      await sampler;
    }

    await Bun.sleep(settleMs);
    const after = await readHeap(client);
    const performanceAfter = performanceEnabled
      ? await readPerformanceMetrics(client)
      : null;

    const peak = samples.reduce<HeapUsage>(
      (best, sample) => (sample.usedSize > best.usedSize ? sample : best),
      baseline,
    );
    const peakWithAfter = after.usedSize > peak.usedSize ? after : peak;

    return {
      sizeMb: Math.round((options.upload.sizeBytes / 1_000_000) * 100) / 100,
      rateMb: Math.round(((options.upload.rateBytesPerSec ?? 0) / 1_000_000) * 100) / 100,
      upload: {
        status: upload.status,
        sentBytes: upload.sentBytes,
        wallMs: upload.wallMs,
        sha256: upload.sentSha256,
      },
      baseline,
      peak: peakWithAfter,
      after,
      peakDeltaBytes: peakWithAfter.usedSize - baseline.usedSize,
      afterDeltaBytes: after.usedSize - baseline.usedSize,
      sampleCount: samples.length,
      samples,
      performanceBefore,
      performanceAfter,
      notes,
    };
  } finally {
    client.close();
  }
}

/**
 * Calibra el sampler de workerd: quema `burnMs` de CPU JS conocida y divide el
 * CPU atribuido entre el número de muestras no-idle. Se hace UNA vez por worker
 * (fuera de las ventanas de medición) para no contaminar el CPU de proceso.
 */
export async function calibrate(options: CalibrationOptions): Promise<CalibrationResult> {
  const wsUrl = await discoverInspector(options.inspectorPort);
  const client = await CdpClient.connect(wsUrl);
  try {
    await client.send("Profiler.enable");
    try {
      await client.send("Profiler.setSamplingInterval", { interval: 100 });
    } catch {
      // workerd puede ignorarlo; el intervalo real se mide igualmente.
    }
    const runs: CpuSummary[] = [];
    const runCount = options.runs ?? 3;
    for (let i = 0; i < runCount; i++) {
      await client.send("Profiler.start");
      await uploadOnce({
        url: options.url,
        sizeBytes: 0,
        chunkBytes: 1024,
        multipart: false,
        method: "GET",
      });
      const { profile } = await client.send<{ profile: Profile }>("Profiler.stop");
      runs.push(summarizeProfile(profile));
    }
    const intervals = runs
      .filter((run) => run.nonIdleSamples > 0)
      .map((run) => run.cpuUs / run.nonIdleSamples)
      .sort((a, b) => a - b);
    const intervalUs = intervals[Math.floor(intervals.length / 2)] ?? 0;
    return { burnMs: options.burnMs, intervalUs, runs };
  } finally {
    client.close();
  }
}

export async function measureBatch(options: MeasureOptions): Promise<BatchResult> {
  const notes: string[] = [];
  const wsUrl = await discoverInspector(options.inspectorPort);
  const client = await CdpClient.connect(wsUrl);

  try {
    await client.send("Profiler.enable");
    let samplingIntervalApplied = true;
    const samplingIntervalUs = 100;
    try {
      await client.send("Profiler.setSamplingInterval", { interval: samplingIntervalUs });
    } catch (error) {
      samplingIntervalApplied = false;
      notes.push(
        `Profiler.setSamplingInterval no soportado: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const intervalUs = options.intervalUs ?? 0;
    if (intervalUs === 0) {
      notes.push("sin calibración: cpuEstimateUs queda a 0 (usar calibrate())");
    }

    const requests: MeasuredRequest[] = [];
    for (let i = 0; i < options.repeat; i++) {
      await client.send("Profiler.start");
      const upload = await uploadOnce(options.upload);
      const { profile } = await client.send<{ profile: Profile }>("Profiler.stop");
      const cpu = summarizeProfile(profile);
      cpu.cpuEstimateUs = cpu.nonIdleSamples * intervalUs;
      requests.push({
        index: i,
        cpu,
        upload,
      });
      if (process.env["BENCH_VERBOSE"] === "1") {
        console.log(
          `      req ${i + 1}/${options.repeat}: status ${upload.status} ` +
            `wall ${upload.wallMs}ms sent ${upload.sentBytes}B ` +
            `errors ${upload.writeErrors.join("; ") || "-"}`,
        );
      }
      if (options.settleMs > 0) await Bun.sleep(options.settleMs);
    }

    const walls = requests.map((request) => request.cpu.wallUs).sort((a, b) => a - b);
    const medianWallUs = walls.length > 0 ? (walls[Math.floor(walls.length / 2)] ?? 0) : 0;
    const idleWindowMs = Math.max(1, Math.round(medianWallUs / 1000));

    const idleWindows: IdleWindow[] = [];
    for (let i = 0; i < options.idleWindows; i++) {
      await client.send("Profiler.start");
      await Bun.sleep(idleWindowMs);
      const { profile } = await client.send<{ profile: Profile }>("Profiler.stop");
      const cpu = summarizeProfile(profile);
      cpu.cpuEstimateUs = cpu.nonIdleSamples * intervalUs;
      idleWindows.push({ index: i, cpu });
    }

    return {
      requests,
      idleWindows,
      samplingIntervalUs,
      samplingIntervalApplied,
      intervalUs,
      notes,
    };
  } finally {
    client.close();
  }
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] ?? 0;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lowValue = sorted[low] ?? 0;
  const highValue = sorted[high] ?? lowValue;
  return lowValue + (highValue - lowValue) * (rank - low);
}

export function stats(values: number[]): {
  n: number;
  p50: number;
  p95: number;
  max: number;
  min: number;
  mean: number;
} {
  if (values.length === 0) return { n: 0, p50: 0, p95: 0, max: 0, min: 0, mean: 0 };
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.max(...values),
    min: Math.min(...values),
    mean: sum / values.length,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const index = args.indexOf(flag);
    return index >= 0 && args[index + 1] !== undefined ? args[index + 1]! : fallback;
  };
  const inspectorPort = Number(get("--inspector", "9240"));
  const url = get("--url", "http://127.0.0.1:8807/proxy");
  const sizeMb = Number(get("--size", "20"));
  const chunkKb = Number(get("--chunk", "1024"));
  const rateMb = Number(get("--rate", "0"));
  const repeat = Number(get("--repeat", "20"));
  const idleWindows = Number(get("--idle-windows", "20"));
  const multipart = args.includes("--multipart");
  const status = Number(get("--status", "200"));

  const calibration = args.includes("--no-calibration")
    ? null
    : await calibrate({
        inspectorPort,
        url: `http://127.0.0.1:${Number(get("--worker-port", "8807"))}/burn?ms=200`,
        burnMs: 200,
      });

  const batch = await measureBatch({
    inspectorPort,
    upload: {
      url,
      sizeBytes: Math.round(sizeMb * 1_000_000),
      chunkBytes: Math.round(chunkKb * 1024),
      rateBytesPerSec: rateMb > 0 ? Math.round(rateMb * 1_000_000) : 0,
      multipart,
      headers:
        status === 200 ? undefined : { "x-sink-status": String(status) },
    },
    repeat,
    idleWindows,
    settleMs: 50,
    intervalUs: calibration?.intervalUs ?? 0,
  });

  const cpu = stats(batch.requests.map((request) => request.cpu.cpuEstimateUs));
  const cpuDelta = stats(batch.requests.map((request) => request.cpu.cpuUs));
  const samples = stats(batch.requests.map((request) => request.cpu.nonIdleSamples));
  const noise = stats(batch.idleWindows.map((window) => window.cpu.cpuEstimateUs));
  const wall = stats(batch.requests.map((request) => request.cpu.wallUs));
  console.log(
    JSON.stringify(
      {
        inspectorPort,
        url,
        sizeMb,
        chunkKb,
        rateMb,
        multipart,
        samplingIntervalUs: batch.samplingIntervalUs,
        samplingIntervalApplied: batch.samplingIntervalApplied,
        calibration,
        notes: batch.notes,
        cpuEstimateUs: cpu,
        cpuDeltaUs: cpuDelta,
        nonIdleSamples: samples,
        meanCpuEstimateUs:
          batch.requests.length > 0
            ? Math.round(
                batch.requests.reduce((acc, r) => acc + r.cpu.cpuEstimateUs, 0) /
                  batch.requests.length,
              )
            : 0,
        noiseUs: noise,
        wallUs: wall,
        statuses: batch.requests.map((request) => request.upload.status),
        cpuPerRequestUs: batch.requests.map((request) =>
          Math.round(request.cpu.cpuEstimateUs),
        ),
        topFrames: batch.requests
          .flatMap((request) => request.cpu.topFrames)
          .reduce<{ name: string; url: string; us: number }[]>((acc, frame) => {
            const existing = acc.find((entry) => entry.name === frame.name);
            if (existing) existing.us += frame.us;
            else acc.push({ name: frame.name, url: frame.url, us: frame.us });
            return acc;
          }, [])
          .sort((a, b) => b.us - a.us)
          .slice(0, 10),
      },
      null,
      2,
    ),
  );
}
