/**
 * Sink local (upstream del proxy). NO es Groq: escucha en 127.0.0.1:8798 y
 * registra la llegada de CADA chunk con su timestamp, además del SHA-256 del
 * cuerpo recibido. Es la prueba de que el proxy no bufferea (R4).
 *
 *   bun scripts/sink.ts [--port 8798]
 *
 * Endpoints:
 *   POST /sink                       → 200 + JSON con el perfil de llegada
 *   POST /sink?status=413|500        → lee el cuerpo y responde ese código
 *   POST /sink?delayMs=250           → retrasa la respuesta (propagación de headers)
 *   GET  /stats                      → último run registrado
 *   POST /reset                      → limpia el último run
 */

export interface SinkChunk {
  /** ms desde la llegada del primer chunk (performance.now, alta resolución) */
  dtMs: number;
  bytes: number;
}

export interface SinkRun {
  runId: number;
  status: number;
  totalBytes: number;
  sha256: string;
  chunkCount: number;
  /** epoch ms (Date.now) al entrar al handler = headers recibidos */
  requestAt: number;
  /** epoch ms del primer chunk del cuerpo */
  firstChunkAt: number;
  /** epoch ms del último chunk del cuerpo */
  lastChunkAt: number;
  /** ms entre requestAt y firstChunkAt */
  headersToFirstChunkMs: number;
  /** ms entre firstChunkAt y lastChunkAt */
  bodySpanMs: number;
  maxGapMs: number;
  meanGapMs: number;
  chunks: SinkChunk[];
  receivedContentLength: string | null;
  receivedTransferEncoding: string | null;
  receivedContentType: string | null;
  receivedContentEncoding: string | null;
  responseBytes: number;
  aborted: boolean;
  readError: string | null;
}

export interface ActiveRun {
  runId: number;
  startedAt: number;
  totalBytes: number;
  chunkCount: number;
  firstChunkAt: number;
  lastChunkAt: number;
  aborted: boolean;
  readError: string | null;
}

let runCounter = 0;
let lastRun: SinkRun | null = null;
/** Run en curso: permite ver si el abort deja el upstream colgado a medias. */
let activeRun: ActiveRun | null = null;

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  const text = JSON.stringify(body);
  return new Response(text, {
    status,
    headers: {
      "content-type": "application/json",
      "x-sink": "proxy-cpu",
      ...extra,
    },
  });
}

async function handleSink(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // El cliente puede pedir un código de error con `x-sink-status`; el proxy
  // reenvía las cabeceras, así se prueba la propagación 413/500 de extremo a
  // extremo (la query no se reenvía porque el upstream es una URL fija).
  const status = Number(
    request.headers.get("x-sink-status") ?? url.searchParams.get("status") ?? "200",
  );
  const delayMs = Number(url.searchParams.get("delayMs") ?? "0");

  const runId = ++runCounter;
  const requestAt = Date.now();
  const t0 = performance.now();

  const chunks: SinkChunk[] = [];
  const hasher = new Bun.CryptoHasher("sha256");
  let totalBytes = 0;
  let firstChunkAt = 0;
  let lastChunkAt = 0;
  let lastPerf = 0;
  let maxGapMs = 0;
  let aborted = false;
  let readError: string | null = null;

  activeRun = {
    runId,
    startedAt: requestAt,
    totalBytes: 0,
    chunkCount: 0,
    firstChunkAt: 0,
    lastChunkAt: 0,
    aborted: false,
    readError: null,
  };

  if (request.body !== null) {
    const reader = request.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        const nowPerf = performance.now();
        const nowEpoch = Date.now();
        if (firstChunkAt === 0) {
          firstChunkAt = nowEpoch;
          lastPerf = nowPerf;
        } else {
          const gap = nowPerf - lastPerf;
          if (gap > maxGapMs) maxGapMs = gap;
          lastPerf = nowPerf;
        }
        lastChunkAt = nowEpoch;
        chunks.push({ dtMs: nowPerf - t0, bytes: value.byteLength });
        hasher.update(value);
        totalBytes += value.byteLength;
        if (activeRun !== null) {
          activeRun.totalBytes = totalBytes;
          activeRun.chunkCount = chunks.length;
          activeRun.firstChunkAt = firstChunkAt;
          activeRun.lastChunkAt = lastChunkAt;
        }
      }
    } catch (error) {
      aborted = true;
      readError = error instanceof Error ? error.message : String(error);
      if (activeRun !== null) {
        activeRun.aborted = true;
        activeRun.readError = readError;
      }
    }
  }

  if (delayMs > 0) await Bun.sleep(delayMs);

  const spanMs = firstChunkAt === 0 ? 0 : lastChunkAt - firstChunkAt;
  let gapSum = 0;
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const cur = chunks[i];
    if (prev === undefined || cur === undefined) continue;
    gapSum += cur.dtMs - prev.dtMs;
  }
  const gapCount = Math.max(0, chunks.length - 1);
  const meanGapMs = gapCount > 0 ? gapSum / gapCount : 0;

  const payload: Omit<SinkRun, "responseBytes"> = {
    runId,
    status,
    totalBytes,
    sha256: hasher.digest("hex"),
    chunkCount: chunks.length,
    requestAt,
    firstChunkAt,
    lastChunkAt,
    headersToFirstChunkMs: firstChunkAt === 0 ? -1 : firstChunkAt - requestAt,
    bodySpanMs: spanMs,
    maxGapMs: Math.round(maxGapMs * 1000) / 1000,
    meanGapMs: Math.round(meanGapMs * 1000) / 1000,
    chunks,
    receivedContentLength: request.headers.get("content-length"),
    receivedTransferEncoding: request.headers.get("transfer-encoding"),
    receivedContentType: request.headers.get("content-type"),
    receivedContentEncoding: request.headers.get("content-encoding"),
    aborted,
    readError,
  };

  lastRun = { ...payload, responseBytes: 0 };
  activeRun = null;
  const text = JSON.stringify(payload);
  const responseBytes = new TextEncoder().encode(text).byteLength;
  lastRun.responseBytes = responseBytes;
  return new Response(text, {
    status,
    headers: {
      "content-type": "application/json",
      "x-sink": "proxy-cpu",
      "x-sink-run": String(runId),
    },
  });
}

export function startSink(port = 8798): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/sink") return handleSink(request);
      if (url.pathname === "/stats") {
        return json({ run: lastRun, active: activeRun });
      }
      if (url.pathname === "/reset") {
        lastRun = null;
        activeRun = null;
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    },
  });
}

export function getLastRun(): SinkRun | null {
  return lastRun;
}

/** Run todavía en curso (el sink no ha terminado de leer el cuerpo). */
export function getActiveRun(): ActiveRun | null {
  return activeRun;
}

/** Limpia el último run (prueba de abort: el sink debe registrar uno nuevo). */
export function resetSink(): void {
  lastRun = null;
  activeRun = null;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const portArg = args.indexOf("--port");
  const port = portArg >= 0 ? Number(args[portArg + 1]) : 8798;
  const server = startSink(port);
  console.log(`[sink] listening on http://127.0.0.1:${server.port}/sink`);
}
