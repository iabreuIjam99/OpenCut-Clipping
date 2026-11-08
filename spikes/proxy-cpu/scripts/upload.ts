/**
 * Cliente de subida con throttle y hash SHA-256 incremental.
 *
 *   bun scripts/upload.ts --url http://127.0.0.1:8807/proxy --size 20 --chunk 1024 \
 *       --rate 2 --multipart --repeat 3
 *
 * El cuerpo se envía con `Transfer-Encoding: chunked` (sin Content-Length), que es
 * el caso realista de un upload de audio en streaming desde el cliente.
 */
import http from "node:http";
import { createHash } from "node:crypto";

export interface UploadOptions {
  url: string;
  /** bytes de payload (sin contar el envelope multipart) */
  sizeBytes: number;
  chunkBytes: number;
  /** 0/undefined = sin throttle */
  rateBytesPerSec?: number;
  multipart: boolean;
  method?: string;
  /** cabeceras extra (p. ej. `x-sink-status` para probar la propagación de 413/500) */
  headers?: Record<string, string> | undefined;
  /** destruye el socket a los N ms (prueba de propagación de abort) */
  abortAfterMs?: number | undefined;
  /** timeout duro por request; 0 = sin timeout (default 60 s) */
  timeoutMs?: number | undefined;
}

export interface TimelineEntry {
  /** epoch ms (Date.now) */
  t: number;
  bytes: number;
}

export interface UploadResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  payloadBytes: number;
  wireBytes: number;
  sentBytes: number;
  sentSha256: string;
  /** epoch ms justo antes de crear el request */
  startAt: number;
  /** epoch ms del primer `req.write` */
  firstWriteAt: number;
  /** epoch ms del último `req.write` */
  lastWriteAt: number;
  /** epoch ms en que terminó la respuesta */
  endAt: number;
  wallMs: number;
  sendTimeline: TimelineEntry[];
  writeErrors: string[];
  abortedByClient: boolean;
}

const PATTERN_SIZE = 64 * 1024;
const PATTERN = Buffer.alloc(PATTERN_SIZE);
for (let i = 0; i < PATTERN_SIZE; i++) PATTERN[i] = i & 0xff;

const BOUNDARY = "----monetizaclip-proxycpu-boundary";

function multipartHead(): Buffer {
  return Buffer.from(
    `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="audio.webm"\r\n` +
      `Content-Type: audio/webm\r\n\r\n`,
    "utf8",
  );
}

function multipartTail(): Buffer {
  return Buffer.from(`\r\n--${BOUNDARY}--\r\n`, "utf8");
}

async function* bodySegments(
  sizeBytes: number,
  multipart: boolean,
): AsyncGenerator<Buffer> {
  if (multipart) yield multipartHead();
  let remaining = sizeBytes;
  while (remaining > 0) {
    const n = Math.min(PATTERN_SIZE, remaining);
    yield PATTERN.subarray(0, n);
    remaining -= n;
  }
  if (multipart) yield multipartTail();
}

export async function uploadOnce(options: UploadOptions): Promise<UploadResult> {
  const {
    url,
    sizeBytes,
    chunkBytes,
    rateBytesPerSec = 0,
    multipart,
    method = "POST",
    headers: extraHeaders,
    abortAfterMs,
    timeoutMs = 60_000,
  } = options;

  const target = new URL(url);
  const headers: Record<string, string> = {
    "user-agent": "monetizaclip-proxy-cpu-spike/1.0",
    ...extraHeaders,
  };
  if (multipart) headers["content-type"] = `multipart/form-data; boundary=${BOUNDARY}`;
  else headers["content-type"] = "application/octet-stream";

  const hash = createHash("sha256");
  const sendTimeline: TimelineEntry[] = [];
  const writeErrors: string[] = [];
  let sentBytes = 0;
  let wireBytes = 0;
  let firstWriteAt = 0;
  let lastWriteAt = 0;
  let responded = false;
  let abortedByClient = false;

  const startAt = Date.now();

  const request = http.request({
    hostname: target.hostname,
    port: target.port === "" ? 80 : Number(target.port),
    path: `${target.pathname}${target.search}`,
    method,
    headers,
  });

  const abortTimer =
    abortAfterMs !== undefined && abortAfterMs > 0
      ? setTimeout(() => {
          abortedByClient = true;
          request.destroy(new Error("client abort"));
        }, abortAfterMs)
      : undefined;

  const timeoutTimer =
    timeoutMs > 0
      ? setTimeout(() => {
          request.destroy(new Error(`request timeout after ${timeoutMs} ms`));
        }, timeoutMs)
      : undefined;

  const responsePromise = new Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    endAt: number;
  }>((resolve, reject) => {
    request.on("response", (response) => {
      responded = true;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const flat: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === "string") flat[key] = value;
          else if (Array.isArray(value)) flat[key] = value.join(", ");
        }
        resolve({
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? "",
          headers: flat,
          body: Buffer.concat(chunks).toString("utf8"),
          endAt: Date.now(),
        });
      });
      response.on("error", reject);
    });
    request.on("error", reject);
  });
  // Evita un unhandled rejection si el abort del cliente ocurre antes de que
  // alguien espere esta promesa (rama catch de abajo).
  void responsePromise.catch(() => {});

  async function writeChunk(buffer: Buffer): Promise<void> {
    if (responded) return;
    if (abortedByClient) throw new Error("client abort");
    wireBytes += buffer.byteLength;
    hash.update(buffer);
    const ok = request.write(buffer);
    sentBytes += buffer.byteLength;
    const now = Date.now();
    if (firstWriteAt === 0) firstWriteAt = now;
    lastWriteAt = now;
    sendTimeline.push({ t: now, bytes: buffer.byteLength });
    if (!ok) {
      // Tras `request.destroy()` el evento `drain` nunca llega: hay que salir
      // también en `close`/`error` o la prueba de abort se cuelga.
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          request.off("drain", finish);
          request.off("close", finish);
          request.off("error", finish);
          resolve();
        };
        request.once("drain", finish);
        request.once("close", finish);
        request.once("error", finish);
      });
    }
    if (rateBytesPerSec > 0 && firstWriteAt > 0) {
      const targetAt = firstWriteAt + (sentBytes / rateBytesPerSec) * 1000;
      const wait = targetAt - Date.now();
      if (wait > 0) await Bun.sleep(wait);
    }
  }

  const pending: Buffer[] = [];
  let pendingBytes = 0;

  async function feed(buffer: Buffer): Promise<void> {
    pending.push(buffer);
    pendingBytes += buffer.byteLength;
    if (pendingBytes < chunkBytes) return;
    const joined = Buffer.concat(pending, pendingBytes);
    pending.length = 0;
    pendingBytes = 0;
    for (let offset = 0; offset < joined.byteLength; offset += chunkBytes) {
      await writeChunk(joined.subarray(offset, Math.min(offset + chunkBytes, joined.byteLength)));
    }
  }

  try {
    for await (const segment of bodySegments(sizeBytes, multipart)) {
      await feed(segment);
      if (responded) break;
    }
    if (!responded && pendingBytes > 0) {
      const tail = Buffer.concat(pending, pendingBytes);
      pending.length = 0;
      pendingBytes = 0;
      await writeChunk(tail);
    }
    if (!responded) request.end();
    const response = await responsePromise;
    if (abortTimer !== undefined) clearTimeout(abortTimer);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: response.body,
      payloadBytes: sizeBytes,
      wireBytes,
      sentBytes,
      sentSha256: hash.digest("hex"),
      startAt,
      firstWriteAt,
      lastWriteAt,
      endAt: response.endAt,
      wallMs: response.endAt - startAt,
      sendTimeline,
      writeErrors,
      abortedByClient,
    };
  } catch (error) {
    if (abortTimer !== undefined) clearTimeout(abortTimer);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    writeErrors.push(error instanceof Error ? error.message : String(error));
    try {
      request.destroy();
    } catch {
      // ignore
    }
    const endAt = Date.now();
    return {
      status: 0,
      statusText: "client-error",
      headers: {},
      body: "",
      payloadBytes: sizeBytes,
      wireBytes,
      sentBytes,
      sentSha256: hash.digest("hex"),
      startAt,
      firstWriteAt,
      lastWriteAt,
      endAt,
      wallMs: endAt - startAt,
      sendTimeline,
      writeErrors,
      abortedByClient,
    };
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const index = args.indexOf(flag);
    return index >= 0 && args[index + 1] !== undefined ? args[index + 1]! : fallback;
  };
  const url = get("--url", "http://127.0.0.1:8807/proxy");
  const sizeMb = Number(get("--size", "20"));
  const chunkKb = Number(get("--chunk", "1024"));
  const rateMb = Number(get("--rate", "0"));
  const repeat = Number(get("--repeat", "1"));
  const multipart = args.includes("--multipart");

  for (let i = 0; i < repeat; i++) {
    const result = await uploadOnce({
      url,
      sizeBytes: Math.round(sizeMb * 1_000_000),
      chunkBytes: Math.round(chunkKb * 1024),
      rateBytesPerSec: rateMb > 0 ? Math.round(rateMb * 1_000_000) : 0,
      multipart,
    });
    console.log(
      JSON.stringify({
        run: i + 1,
        status: result.status,
        sentBytes: result.sentBytes,
        sha256: result.sentSha256,
        wallMs: result.wallMs,
        sendSpanMs: result.lastWriteAt - result.firstWriteAt,
        body: result.body.slice(0, 400),
        errors: result.writeErrors,
      }),
    );
  }
}
