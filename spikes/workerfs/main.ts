/**
 * Spike WORKERFS + códec (Go/No-Go) — MonetizaClip.
 *
 * Hipótesis a validar: montar el vídeo del usuario con `WORKERFS` evita copiar
 * sus bytes al heap de WASM (`writeFile(arrayBuffer)` OOMaría a ~400-800 MB) y
 * permite extraer audio de ficheros de 2 GB en Chrome de escritorio.
 *
 * Resultados: `window.__SPIKE_RESULTS__` (JSON) + <pre id="results">.
 * Reglas: NUNCA writeFile del vídeo — solo `ffmpeg.mount("WORKERFS", ...)`.
 */
import { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";
import type { FFMessageLoadConfig, LogEvent, ProgressEvent } from "@ffmpeg/ffmpeg";

// ---------------------------------------------------------------------------
// Tipos (strict, cero `any`)
// ---------------------------------------------------------------------------

type CoreKind = "st" | "mt";
type EncoderChoice = "libopus" | "libmp3lame";
type Outcome = "OK" | "ERROR" | "RUNNING" | "INTERRUPTED";

interface SpikeResult {
  fixture: string;
  inputName: string;
  inputBytes: number;
  inputMime: string;
  core: CoreKind;
  coreLabel: string;
  encoder: EncoderChoice;
  ffmpegArgs: string[];
  mountMs: number;
  execMs: number;
  exitCode: number | null;
  outputBytes: number;
  outputMime: string;
  outputDurationMs: number | null;
  peakJsHeapMB: number;
  peakPageMemoryMB: number | null;
  pageBreakdown: PageBreakdownEntry[];
  /** Medición UASM final esperada tras `exec` (la que soporta «sin OOM»). */
  pageFinalBytes: number | null;
  pageFinalBreakdown: PageBreakdownEntry[];
  pageFinalError: string | null;
  /** Muestras UASM periódicas aceptadas / rechazadas por límite de la API. */
  pageSamples: number;
  pageRejected: number;
  pageFirstError: string | null;
  /** Intervalo final alcanzado entre muestras UASM (ms) tras la adaptación. */
  pageSampleIntervalMs: number | null;
  memorySamples: number;
  pageMemoryError: string | null;
  logMessages: number;
  outcome: Outcome;
  error: string | null;
  startedAt: string;
}

interface PageBreakdownEntry {
  /** URL atribuida (p. ej. la página o `.../ffmpeg/worker.js`); `(sin url)` si no la hay. */
  url: string;
  bytes: number;
  /** `Window`, `DedicatedWorkerGlobalScope`, … (según `attribution[].scope`). */
  scope?: string;
  /** `JavaScript`, `DOM`, `Shared`, … (según `types`). */
  types?: string[];
}

interface SpikeEnv {
  userAgent: string;
  chromeVersion: string;
  deviceMemoryGB: number | null;
  hardwareConcurrency: number;
  crossOriginIsolated: boolean;
  jsHeapLimitMB: number;
}

interface SpikeInfo {
  core: CoreKind;
  coreLabel: string;
  loadMs: number;
  ffmpegVersion: string;
  encoder: EncoderChoice;
  hasLibopus: boolean;
  hasLibmp3lame: boolean;
  audioEncoders: string[];
  encodersLog: string;
  encoderChain: string[];
  env: SpikeEnv;
}

interface SpikeStatus {
  ready: boolean;
  running: boolean;
  current: string | null;
}

declare global {
  interface Window {
    __SPIKE_RESULTS__: SpikeResult[];
    __SPIKE_INFO__: SpikeInfo | null;
    __SPIKE_STATUS__: SpikeStatus;
  }
}

interface CoreSpec {
  readonly coreURL: string;
  readonly wasmURL: string;
  readonly workerURL: string | null;
  readonly label: string;
}

const CORE_SPECS: Readonly<Record<CoreKind, CoreSpec>> = {
  st: {
    coreURL: "/core/ffmpeg-core.js",
    wasmURL: "/core/ffmpeg-core.wasm",
    workerURL: null,
    label: "@ffmpeg/core@0.12.10 single-thread",
  },
  mt: {
    coreURL: "/core-mt/ffmpeg-core.js",
    wasmURL: "/core-mt/ffmpeg-core.wasm",
    workerURL: "/core-mt/ffmpeg-core.worker.js",
    label: "@ffmpeg/core-mt@0.12.10 multithread",
  },
};

const MB = 1024 * 1024;
const STORAGE_KEY = "monetizaclip.workerfs-spike.v1";
const MAX_LOG_LINES = 5000;
const LOG_DROP_CHUNK = 500;
const UI_LOG_LINES = 200;
const MAX_INPUT_BYTES = 8 * 1024 * MB;
const TICK_MS = 250;
const PERSIST_TICKS = 40; // persist/publish cada 10 s (250 ms × 40)
// Muestreo de `measureUserAgentSpecificMemory()`: se arranca a 2 s y se adapta
// (×2 con backoff ante rechazo de cuota/límite, ×0,75 con éxito, tope 30 s)
// para terminar en la máxima frecuencia que la API acepte.
const PAGE_MEM_START_MS = 2000;
const PAGE_MEM_MIN_MS = 1000;
const PAGE_MEM_MAX_MS = 30000;
// Red de seguridad de la medición final: si la API se colgara, la corrida no
// queda bloqueada en «esperando UASM final» (no ocurrió en ninguna corrida).
const PAGE_FINAL_TIMEOUT_MS = 60000;
const ALLOWED_MIME: readonly string[] = ["video/mp4", "video/x-m4v", "video/quicktime"];

// `performance.memory` y `measureUserAgentSpecificMemory()` no están (o no están
// completos) en lib.dom: se acceden mediante un tipo propio, sin `any`.
// Chrome >= 110 devuelve `{ bytes, breakdown }`; versiones antiguas devolvían
// un ArrayBuffer: se aceptan las dos formas.
type UasmResponse = ArrayBuffer | { bytes?: number; breakdown?: unknown };

const perfExt = performance as unknown as {
  readonly memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
  readonly measureUserAgentSpecificMemory?: () => Promise<UasmResponse>;
};

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

let ffmpeg: FFmpeg | null = null;
let coreKind: CoreKind = "st";
let info: SpikeInfo | null = null;
const results: SpikeResult[] = [];
let running = false;
let currentFixture: string | null = null;
let lastOutputPath: string | null = null;
let capture: string[] | null = null;
const logLines: string[] = [];
let lastProgress: number | null = null;
let lastLogRender = 0;
let logRenderTimer: number | null = null;

interface SamplerState {
  intervalId: number;
  pageTimerId: number;
  pagePromise: Promise<void> | null;
  pageIntervalMs: number;
  execStart: number;
  /** true cuando `exec` ya resolvió: el reloj de `execMs` deja de avanzar. */
  execLocked: boolean;
  peakJs: number;
  peakPage: number | null;
  peakBreakdown: PageBreakdownEntry[];
  lastPage: number | null;
  lastBreakdown: PageBreakdownEntry[];
  samples: number;
  pageSamples: number;
  pageRejected: number;
  pageFirstError: string | null;
  pageLastError: string | null;
  pageErr: string | null;
  result: SpikeResult;
}
let sampler: SamplerState | null = null;
let logPushCount = 0;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`#${id} no encontrado`);
  return node as T;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function setStatus(text: string): void {
  byId<HTMLElement>("status").textContent = text;
}

function publish(): void {
  window.__SPIKE_RESULTS__ = results;
  window.__SPIKE_INFO__ = info;
  window.__SPIKE_STATUS__ = { ready: info !== null && ffmpeg !== null, running, current: currentFixture };
  renderResults();
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(results));
  } catch {
    // cuota superada: el resultado sigue visible en memoria
  }
}

function restore(): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw === null) return;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    let recovered = 0;
    for (const item of parsed as SpikeResult[]) {
      if (item.outcome === "RUNNING") {
        item.outcome = "INTERRUPTED";
        item.error =
          "la ejecución no terminó (recarga, crash de la pestaña o cierre); execMs es el último valor persistido";
        recovered++;
      }
      item.pageBreakdown ??= [];
      item.pageFinalBytes ??= null;
      item.pageFinalBreakdown ??= [];
      item.pageFinalError ??= null;
      item.pageSamples ??= 0;
      item.pageRejected ??= 0;
      item.pageFirstError ??= null;
      item.pageSampleIntervalMs ??= null;
      item.logMessages ??= 0;
      results.push(item);
    }
    if (recovered > 0) {
      pushLog(`recuperadas ${recovered} ejecución(es) interrumpida(s) de localStorage (¿crash de pestaña?)`);
    }
  } catch {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignorar */
    }
  }
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

function renderLog(): void {
  lastLogRender = performance.now();
  const pre = byId<HTMLPreElement>("log");
  const start = Math.max(0, logLines.length - UI_LOG_LINES);
  pre.textContent = logLines.slice(start).join("\n");
  pre.scrollTop = pre.scrollHeight;
}

function renderLogSoon(): void {
  const since = performance.now() - lastLogRender;
  if (since > 200) {
    renderLog();
    return;
  }
  if (logRenderTimer !== null) return;
  logRenderTimer = window.setTimeout(() => {
    logRenderTimer = null;
    renderLog();
  }, 200);
}

function pushLog(line: string): void {
  logLines.push(line);
  logPushCount++;
  // ffmpeg.wasm imprime a nivel debug (decenas de miles de líneas por ejecución
  // larga): se descartan bloques completos para no pagar un O(n) por mensaje.
  if (logLines.length >= MAX_LOG_LINES + LOG_DROP_CHUNK) {
    logLines.splice(0, logLines.length - MAX_LOG_LINES);
  }
  renderLogSoon();
}

function handleLog(event: LogEvent): void {
  if (capture !== null) capture.push(event.message);
  pushLog(event.message);
}

function handleProgress(event: ProgressEvent): void {
  lastProgress = event.progress;
}

function renderResults(): void {
  byId<HTMLPreElement>("results").textContent = JSON.stringify(results, null, 2);
}

// ---------------------------------------------------------------------------
// Entorno
// ---------------------------------------------------------------------------

function renderEnv(): void {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const ua = navigator.userAgent;
  const m = /Chrome\/([\d.]+)/.exec(ua);
  const env: SpikeEnv = {
    userAgent: ua,
    chromeVersion: m?.[1] ?? "desconocida",
    deviceMemoryGB: nav.deviceMemory ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated: window.crossOriginIsolated,
    jsHeapLimitMB: round2((perfExt.memory?.jsHeapSizeLimit ?? 0) / MB),
  };
  if (info !== null) info.env = env;
  const dl = byId<HTMLDListElement>("env");
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["Chrome", env.chromeVersion],
    ["userAgent", env.userAgent],
    ["navigator.deviceMemory", `${env.deviceMemoryGB ?? "?"} GB (cota declarada por el SO)`],
    ["hardwareConcurrency", String(env.hardwareConcurrency)],
    ["crossOriginIsolated (COOP/COEP)", String(env.crossOriginIsolated)],
    ["jsHeapSizeLimit", `${env.jsHeapLimitMB} MB`],
    [
      "señal",
      typeof perfExt.measureUserAgentSpecificMemory === "function"
        ? "performance.measureUserAgentSpecificMemory() disponible"
        : "measureUserAgentSpecificMemory NO disponible",
    ],
  ];
  dl.replaceChildren(...rows.map(([k, v]) => {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    const frag = document.createDocumentFragment();
    frag.append(dt, dd);
    return frag;
  }));
}

function renderCoreInfo(): void {
  const dl = byId<HTMLDListElement>("core-info");
  if (info === null) {
    dl.replaceChildren();
    return;
  }
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["ffmpeg", info.ffmpegVersion],
    ["core usado", info.coreLabel],
    ["load() ms", String(Math.round(info.loadMs))],
    ["hasLibopus", String(info.hasLibopus)],
    ["hasLibmp3lame", String(info.hasLibmp3lame)],
    ["códec elegido", info.encoder],
    ["encoders de audio", info.audioEncoders.join(", ")],
  ];
  dl.replaceChildren(...rows.map(([k, v]) => {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    const frag = document.createDocumentFragment();
    frag.append(dt, dd);
    return frag;
  }));
  byId<HTMLElement>("chain").textContent = info.encoderChain.join(" → ");
  byId<HTMLElement>("core-status").textContent = `${info.coreLabel} + ${info.encoder}`;
}

// ---------------------------------------------------------------------------
// Núcleo ffmpeg (cadena de intentos R3)
// ---------------------------------------------------------------------------

async function captureExec(args: string[]): Promise<string> {
  if (ffmpeg === null) throw new Error("ffmpeg no cargado");
  const buf: string[] = [];
  capture = buf;
  let code = -1;
  try {
    code = await ffmpeg.exec(args);
  } finally {
    capture = null;
  }
  buf.push(`(exit=${code})`);
  return buf.join("\n");
}

function parseAudioEncoders(log: string): string[] {
  const names: string[] = [];
  for (const line of log.split(/\r?\n/)) {
    const m = /^\s*([AVS])[.\w]{5}\s+(\S+)/.exec(line);
    if (m === null || m[1] !== "A" || m[2] === undefined) continue;
    const name = m[2];
    if (/^[a-z0-9][a-z0-9_.-]*$/i.test(name)) names.push(name);
  }
  return [...new Set(names)];
}

/** Carga un core, mide `load()`, recolecta `-version` y `-encoders` (evidencia). */
async function loadCore(kind: CoreKind): Promise<void> {
  if (ffmpeg !== null) {
    ffmpeg.terminate();
    ffmpeg = null;
  }
  const spec = CORE_SPECS[kind];
  const inst = new FFmpeg();
  inst.on("log", handleLog);
  inst.on("progress", handleProgress);
  ffmpeg = inst;
  const cfg: FFMessageLoadConfig = {
    classWorkerURL: "/ffmpeg/worker.js",
    coreURL: spec.coreURL,
    wasmURL: spec.wasmURL,
  };
  if (spec.workerURL !== null) cfg.workerURL = spec.workerURL;
  const t0 = performance.now();
  await inst.load(cfg);
  const loadMs = performance.now() - t0;
  coreKind = kind;
  const versionLog = await captureExec(["-version"]);
  const version = (versionLog.split(/\r?\n/)[0] ?? "sin versión").trim();
  const encodersLog = await captureExec(["-encoders"]);
  const audioEncoders = parseAudioEncoders(encodersLog);
  const prev = info;
  const next: SpikeInfo = {
    core: kind,
    coreLabel: spec.label,
    loadMs,
    ffmpegVersion: version,
    encoder: prev?.encoder ?? "libopus",
    hasLibopus: audioEncoders.includes("libopus"),
    hasLibmp3lame: audioEncoders.includes("libmp3lame"),
    audioEncoders,
    encodersLog,
    encoderChain: prev?.encoderChain ?? [],
    env: prev?.env ?? buildEnvFallback(),
  };
  info = next;
  pushLog(`core cargado: ${spec.label} en ${Math.round(loadMs)} ms; encoders de audio: ${audioEncoders.join(", ")}`);
}

function buildEnvFallback(): SpikeEnv {
  return {
    userAgent: navigator.userAgent,
    chromeVersion: "pendiente",
    deviceMemoryGB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated: window.crossOriginIsolated,
    jsHeapLimitMB: round2((perfExt.memory?.jsHeapSizeLimit ?? 0) / MB),
  };
}

/**
 * R3 — cadena de intentos:
 *  1. @ffmpeg/core (single-thread) + libopus
 *  2. si no hay libopus → @ffmpeg/core-mt (sirve con COOP/COEP)
 *  3. si tampoco → libmp3lame (-b:a 32k -f mp3)
 */
async function initEncoderChain(): Promise<void> {
  const chain: string[] = [];
  await loadCore("st");
  const first = info;
  if (first === null) throw new Error("sin info de core");
  if (first.hasLibopus) {
    chain.push(`R3.1: ${first.coreLabel} trae libopus → "-c:a libopus -b:a 24k -f webm"`);
  } else {
    chain.push(`R3.1: ${first.coreLabel} NO trae libopus → probar @ffmpeg/core-mt`);
    await loadCore("mt");
    const second = info;
    if (second === null) throw new Error("sin info de core");
    if (second.hasLibopus) {
      chain.push(`R3.2: core-mt trae libopus → "-c:a libopus -b:a 24k -f webm"`);
    } else if (second.hasLibmp3lame) {
      chain.push("R3.2: core-mt tampoco trae libopus → R3.3 fallback libmp3lame (-b:a 32k -f mp3)");
    } else {
      chain.push("R3.2/3: ningún códec de audio disponible");
    }
  }
  const cur = info;
  if (cur === null) throw new Error("sin info de core");
  if (cur.hasLibopus) {
    cur.encoder = "libopus";
  } else if (cur.hasLibmp3lame) {
    cur.encoder = "libmp3lame";
  } else {
    throw new Error("el core no trae ni libopus ni libmp3lame");
  }
  cur.encoderChain = chain;
}

// ---------------------------------------------------------------------------
// Memoria
// ---------------------------------------------------------------------------

/** ¿El fallo encaja con el límite de frecuencia/cuota de la API? */
function isRateLimitError(text: string): boolean {
  return /quota|cuota|securityerror|rate|frecuencia|limi/i.test(text);
}

/**
 * Toma UNA muestra UASM. Nunca lanza: registra rechazos (cuota/límite) y
 * retrocede el intervalo para respetar la máxima frecuencia que la API acepte.
 */
async function samplePageMemory(st: SamplerState): Promise<void> {
  try {
    const fn = perfExt.measureUserAgentSpecificMemory;
    if (typeof fn !== "function") {
      if (st.pageErr === null) {
        st.pageErr = "performance.measureUserAgentSpecificMemory() no disponible";
      }
      return;
    }
    const measured = readMeasurement(await fn.call(performance));
    if (measured === null) {
      if (st.pageErr === null) st.pageErr = "respuesta inesperada de measureUserAgentSpecificMemory";
      return;
    }
    if (!Number.isFinite(measured.bytes) || measured.bytes <= 0) return;
    st.pageSamples++;
    st.lastPage = measured.bytes;
    st.lastBreakdown = measured.breakdown;
    if (st.peakPage === null || measured.bytes > st.peakPage) {
      st.peakPage = measured.bytes;
      st.peakBreakdown = measured.breakdown;
    }
    // Éxito: se acerca al límite de frecuencia que la API tolere (min 1 s).
    st.pageIntervalMs = Math.max(PAGE_MEM_MIN_MS, Math.round(st.pageIntervalMs * 0.75));
  } catch (e) {
    const text = msg(e);
    st.pageRejected++;
    if (st.pageFirstError === null) st.pageFirstError = text;
    st.pageLastError = text;
    if (st.pageErr === null) st.pageErr = text;
    if (isRateLimitError(text)) {
      st.pageIntervalMs = Math.min(st.pageIntervalMs * 2, PAGE_MEM_MAX_MS);
      pushLog(
        `UASM rechazada #${st.pageRejected}: ${text} → intervalo ${st.pageIntervalMs} ms (respeta el límite de la API)`,
      );
    }
  }
}

/** Toma una muestra si no hay otra en vuelo (une al llamador a la promesa activa). */
async function takePageSample(st: SamplerState): Promise<void> {
  if (st.pagePromise !== null) return st.pagePromise;
  const call = samplePageMemory(st);
  st.pagePromise = call;
  try {
    await call;
  } finally {
    st.pagePromise = null;
  }
}

/** Cadena de muestreo periódico UASM; se reprograma solo mientras viva la corrida. */
function schedulePageSample(st: SamplerState): void {
  st.pageTimerId = window.setTimeout(() => {
    void takePageSample(st).then(() => {
      if (sampler === st) schedulePageSample(st);
    });
  }, st.pageIntervalMs);
}

/**
 * Medición UASM final: se espera (await) DESPUÉS de que `exec` resuelva y ANTES
 * de `stopSampler`, para no perder el máximo del final de la corrida. Es el
 * número que soporta «sin OOM».
 */
async function takeFinalPageSample(result: SpikeResult): Promise<void> {
  const st = sampler;
  if (st === null) return;
  window.clearTimeout(st.pageTimerId); // corta el muestreo periódico
  const samplesBefore = st.pageSamples;
  const rejectionsBefore = st.pageRejected;
  let timedOut = false;
  let timeoutId = 0;
  const timeout = new Promise<void>((resolve) => {
    timeoutId = window.setTimeout(() => {
      timedOut = true;
      resolve();
    }, PAGE_FINAL_TIMEOUT_MS);
  });
  await Promise.race([takePageSample(st), timeout]);
  window.clearTimeout(timeoutId);
  if (st.pageSamples > samplesBefore) {
    result.pageFinalBytes = st.lastPage;
    result.pageFinalBreakdown = st.lastBreakdown;
    result.pageFinalError = null;
  } else {
    result.pageFinalBytes = null;
    result.pageFinalBreakdown = [];
    result.pageFinalError = timedOut
      ? `timeout de ${PAGE_FINAL_TIMEOUT_MS} ms esperando la medición UASM final`
      : st.pageRejected > rejectionsBefore
        ? (st.pageLastError ?? "measureUserAgentSpecificMemory rechazada")
        : (st.pageErr ?? "sin medición UASM final");
  }
}

function readMeasurement(res: UasmResponse): { bytes: number; breakdown: PageBreakdownEntry[] } | null {
  if (res instanceof ArrayBuffer) return { bytes: res.byteLength, breakdown: [] };
  if (typeof res !== "object" || res === null || typeof res.bytes !== "number") return null;
  const breakdown: PageBreakdownEntry[] = [];
  pushBreakdown(res.breakdown, "(sin url)", undefined, breakdown);
  return { bytes: res.bytes, breakdown };
}

/**
 * Aplana el `breakdown` de UASM. Chrome 156 devuelve entradas planas con
 * `attribution: [{ scope, url }]` y `types: string[]`; se acepta también la
 * forma antigua (`url` directo) y una eventual anidación (`breakdown` hijo).
 */
function pushBreakdown(entries: unknown, inheritedUrl: string, inheritedScope: string | undefined, out: PageBreakdownEntry[]): void {
  if (!Array.isArray(entries)) return;
  for (const item of entries) {
    if (typeof item !== "object" || item === null || !("bytes" in item)) continue;
    const rawBytes: unknown = item.bytes;
    const bytes = typeof rawBytes === "number" ? rawBytes : 0;
    let url = inheritedUrl;
    let scope = inheritedScope;
    const attr: unknown = "attribution" in item ? item.attribution : undefined;
    if (Array.isArray(attr)) {
      for (const a of attr) {
        if (typeof a !== "object" || a === null) continue;
        if ("url" in a && typeof a.url === "string" && a.url !== "") url = a.url;
        if ("scope" in a && typeof a.scope === "string" && a.scope !== "") scope = a.scope;
      }
    } else if ("url" in item && typeof item.url === "string" && item.url !== "") {
      url = item.url;
    }
    const types: string[] = [];
    if ("types" in item && Array.isArray(item.types)) {
      for (const t of item.types) if (typeof t === "string") types.push(t);
    }
    const child: unknown = "breakdown" in item ? item.breakdown : undefined;
    if (Array.isArray(child) && child.length > 0) {
      // El padre suele ser la suma de los hijos: se publican solo las hojas.
      pushBreakdown(child, url, scope, out);
    } else {
      const entry: PageBreakdownEntry = { url, bytes };
      if (scope !== undefined) entry.scope = scope;
      if (types.length > 0) entry.types = types;
      out.push(entry);
    }
  }
}

function updateRunUi(): void {
  const st = sampler;
  if (st === null || currentFixture === null) return;
  const pct = lastProgress === null ? null : Math.round(lastProgress * 100);
  const pctText = pct === null ? "" : ` · ${pct}%`;
  const stateText = st.execLocked
    ? "esperando medición UASM final…"
    : `ejecutando ${((performance.now() - st.execStart) / 1000).toFixed(1)}s${pctText}`;
  const uasmText =
    st.lastPage !== null && Number.isFinite(st.lastPage)
      ? ` · UASM ${round2(st.lastPage / MB)} MB (cada ${st.pageIntervalMs} ms)`
      : " · UASM pendiente";
  byId<HTMLElement>(`state-${currentFixture}`).textContent = stateText;
  byId<HTMLElement>(`detail-${currentFixture}`).textContent =
    `heap JS ${round2(st.peakJs / MB)} MB (cota inferior)${uasmText}`;
}

/** Congela el reloj de `execMs` (llamar en cuanto `exec` resuelva). */
function lockExecClock(): void {
  if (sampler !== null) sampler.execLocked = true;
}

function pageMb(peak: number | null): number | null {
  return peak !== null && Number.isFinite(peak) ? round2(peak / MB) : null;
}

function tick(st: SamplerState): void {
  const used = perfExt.memory?.usedJSHeapSize ?? 0;
  if (used > st.peakJs) st.peakJs = used;
  st.samples++;
  const r = st.result;
  // Tras `exec` el reloj queda bloqueado: la espera de la medición UASM final
  // (segundos) no debe contaminar `execMs`.
  if (!st.execLocked) r.execMs = Math.round(performance.now() - st.execStart);
  r.peakJsHeapMB = round2(st.peakJs / MB);
  r.peakPageMemoryMB = pageMb(st.peakPage);
  r.pageBreakdown = st.peakBreakdown;
  r.pageMemoryError = st.pageErr;
  r.pageSamples = st.pageSamples;
  r.pageRejected = st.pageRejected;
  r.pageFirstError = st.pageFirstError;
  r.pageSampleIntervalMs = st.pageIntervalMs;
  r.memorySamples = st.samples;
  if (st.samples % PERSIST_TICKS === 0) {
    persist();
    publish();
  }
  updateRunUi();
}

function startSampler(result: SpikeResult): void {
  const st: SamplerState = {
    intervalId: 0,
    pageTimerId: 0,
    pagePromise: null,
    pageIntervalMs: PAGE_MEM_START_MS,
    execStart: performance.now(),
    execLocked: false,
    peakJs: perfExt.memory?.usedJSHeapSize ?? 0,
    peakPage: null,
    peakBreakdown: [],
    lastPage: null,
    lastBreakdown: [],
    samples: 0,
    pageSamples: 0,
    pageRejected: 0,
    pageFirstError: null,
    pageLastError: null,
    pageErr: null,
    result,
  };
  st.intervalId = window.setInterval(() => tick(st), TICK_MS);
  sampler = st;
  schedulePageSample(st);
  tick(st);
}

function stopSampler(result: SpikeResult): void {
  const st = sampler;
  if (st === null) return;
  window.clearInterval(st.intervalId);
  window.clearTimeout(st.pageTimerId);
  sampler = null;
  const used = perfExt.memory?.usedJSHeapSize ?? 0;
  if (used > st.peakJs) st.peakJs = used;
  st.samples++;
  result.peakJsHeapMB = round2(st.peakJs / MB);
  result.peakPageMemoryMB = pageMb(st.peakPage);
  result.pageBreakdown = st.peakBreakdown;
  result.pageMemoryError = st.pageErr;
  result.pageSamples = st.pageSamples;
  result.pageRejected = st.pageRejected;
  result.pageFirstError = st.pageFirstError;
  result.pageSampleIntervalMs = st.pageIntervalMs;
  result.memorySamples = st.samples;
}

// ---------------------------------------------------------------------------
// Validación de entrada (MIME + tamaño)
// ---------------------------------------------------------------------------

function validateInput(file: File): string | null {
  if (file.size === 0) return "fichero vacío";
  if (file.size > MAX_INPUT_BYTES) return `demasiado grande (máx ${MAX_INPUT_BYTES / MB} MiB)`;
  const extOk = /\.mp4$/i.test(file.name);
  if (ALLOWED_MIME.includes(file.type)) return null;
  if (file.type === "" && extOk) return null;
  return `MIME no permitido: "${file.type}"`;
}

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------

async function decodeDurationMs(data: Uint8Array): Promise<number | null> {
  try {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    const ctx = new OfflineAudioContext(1, 1, 8000);
    const audio = await ctx.decodeAudioData(copy.buffer);
    return Math.round(audio.duration * 1000);
  } catch (e) {
    pushLog(`decodeAudioData falló: ${msg(e)}`);
    return null;
  }
}

async function unmountQuiet(): Promise<void> {
  if (ffmpeg === null) return;
  try {
    await ffmpeg.unmount("/input");
  } catch {
    /* no estaba montado */
  }
}

/**
 * Emscripten `FS.mount()` exige que el punto de montaje exista ya como
 * directorio en MEMFS: sin esto lanza `ErrnoError: FS error`.
 */
async function ensureDir(path: string): Promise<void> {
  if (ffmpeg === null) return;
  try {
    await ffmpeg.createDir(path);
  } catch {
    /* ya existe */
  }
}

function setFixtureState(fixture: string, cls: string, text: string): void {
  const badge = byId<HTMLElement>(`state-${fixture}`);
  badge.className = `badge ${cls}`;
  badge.textContent = text;
}

function updateButtons(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>("button[data-fixture]")) {
    btn.disabled = running;
  }
  byId<HTMLButtonElement>("clean").disabled = running;
  byId<HTMLButtonElement>("reload-core").disabled = running;
}

function writeMarker(r: SpikeResult, label: string): void {
  const line = `RUN_DONE: ${label} ${r.outcome} exec=${Math.round(r.execMs)}ms mount=${round2(r.mountMs)}ms out=${r.outputBytes}B`;
  const div = document.createElement("div");
  let markerId = `marker-${label}`;
  if (document.getElementById(markerId) !== null) markerId = `${markerId}-${Date.now()}`;
  div.id = markerId;
  div.textContent = line;
  byId<HTMLElement>("markers").appendChild(div);
}

async function runFixture(fixtureId: string): Promise<void> {
  if (running) {
    setStatus("ya hay una ejecución en curso");
    return;
  }
  if (ffmpeg === null || info === null) {
    setStatus("el core aún no está cargado");
    return;
  }
  const input = byId<HTMLInputElement>(`file-${fixtureId}`);
  const file = input.files?.[0];
  if (file === undefined) {
    setStatus(`selecciona un fichero para ${fixtureId}`);
    return;
  }
  const invalid = validateInput(file);
  if (invalid !== null) {
    setStatus(`entrada rechazada: ${invalid}`);
    return;
  }

  const encoder = info.encoder;
  const ext = encoder === "libopus" ? "webm" : "mp3";
  const outPath = `/output/audio.${ext}`;
  // Comando de PRODUCCIÓN (ADR-02 / plan Task 6 Step 2): `-vbr off` siempre para
  // libopus. El checkbox solo activa el diagnóstico con el comando literal VBR.
  const literalVbr = encoder === "libopus" && byId<HTMLInputElement>("literal-vbr").checked;
  const args: string[] = [
    "-i", `/input/${file.name}`,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", encoder,
    "-b:a", encoder === "libopus" ? "24k" : "32k",
  ];
  if (encoder === "libopus" && !literalVbr) args.push("-vbr", "off");
  args.push("-f", ext, outPath);
  const label = literalVbr ? `${fixtureId}-vbr` : `${fixtureId}-cbr`;

  const result: SpikeResult = {
    fixture: fixtureId,
    inputName: file.name,
    inputBytes: file.size,
    inputMime: file.type === "" ? "(vacío)" : file.type,
    core: coreKind,
    coreLabel: info.coreLabel,
    encoder,
    ffmpegArgs: args,
    mountMs: 0,
    execMs: 0,
    exitCode: null,
    outputBytes: 0,
    outputMime: `audio/${ext === "webm" ? "webm" : "mpeg"}`,
    outputDurationMs: null,
    peakJsHeapMB: 0,
    peakPageMemoryMB: null,
    pageBreakdown: [],
    pageFinalBytes: null,
    pageFinalBreakdown: [],
    pageFinalError: null,
    pageSamples: 0,
    pageRejected: 0,
    pageFirstError: null,
    pageSampleIntervalMs: null,
    memorySamples: 0,
    pageMemoryError: null,
    logMessages: 0,
    outcome: "RUNNING",
    error: null,
    startedAt: new Date().toISOString(),
  };
  results.push(result);
  running = true;
  currentFixture = fixtureId;
  lastProgress = null;
  updateButtons();
  setFixtureState(fixtureId, "run", "montando…");
  setStatus(`montando ${file.name} (${(file.size / MB).toFixed(1)} MiB) con WORKERFS…`);
  publish();
  persist();
  pushLog(`--- ${fixtureId}: mount WORKERFS → ${args.join(" ")}`);

  startSampler(result);
  try {
    await ensureDir("/output");
    await ensureDir("/input");
    await unmountQuiet();

    const tMount = performance.now();
    const ok = await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, "/input");
    result.mountMs = performance.now() - tMount;
    if (ok !== true) throw new Error("WORKERFS no está disponible en este core");
    pushLog(`mount OK en ${Math.round(result.mountMs)} ms (sin writeFile del vídeo)`);

    setFixtureState(fixtureId, "run", "ejecutando…");
    setStatus(`extrayendo audio de ${fixtureId}…`);
    const tExec = performance.now();
    const logBefore = logPushCount;
    const exitCode = await ffmpeg.exec(args);
    result.execMs = performance.now() - tExec;
    lockExecClock(); // el reloj no debe avanzar mientras esperamos la UASM final
    result.logMessages = logPushCount - logBefore;
    result.exitCode = exitCode;
    if (exitCode !== 0) throw new Error(`ffmpeg devolvió exit code ${exitCode}`);

    const data = await ffmpeg.readFile(outPath);
    if (typeof data === "string") throw new Error("la salida no es un buffer binario");
    lastOutputPath = outPath;
    result.outputBytes = data.byteLength;
    pushLog(`salida: ${data.byteLength} bytes (${result.outputMime})`);
    result.outputDurationMs = await decodeDurationMs(data);
    result.outcome = "OK";
    setFixtureState(fixtureId, "ok", "OK");
    setStatus(`${fixtureId}: OK en ${Math.round(result.execMs)} ms`);
  } catch (e) {
    result.outcome = "ERROR";
    result.error = msg(e);
    setFixtureState(fixtureId, "err", "ERROR");
    setStatus(`${fixtureId}: ERROR — ${result.error}`);
    pushLog(`ERROR en ${fixtureId}: ${result.error}`);
  } finally {
    // Medición UASM final: esperada tras `exec` y ANTES de parar el sampler
    // (es el número que soporta «sin OOM»). Nunca lanza.
    lockExecClock();
    await takeFinalPageSample(result);
    stopSampler(result);
    running = false;
    currentFixture = null;
    lastProgress = null;
    updateButtons();
    publish();
    persist();
    writeMarker(result, label);
    renderCoreInfo();
  }
}

async function cleanAll(): Promise<void> {
  if (ffmpeg === null) return;
  setStatus("limpiando (unmount + delete)…");
  await unmountQuiet();
  if (lastOutputPath !== null) {
    try {
      await ffmpeg.deleteFile(lastOutputPath);
    } catch {
      /* no existe */
    }
    lastOutputPath = null;
  }
  try {
    await ffmpeg.deleteDir("/output");
  } catch {
    /* no existe */
  }
  try {
    // El montaje WORKERFS quedó en /input: se borra también el directorio
    // (tolera que no exista).
    await ffmpeg.deleteDir("/input");
  } catch {
    /* no existe */
  }
  setStatus("limpio: montaje, /input y /output borrados");
  pushLog("cleanup OK (unmount + deleteDir /input y /output)");
}

async function switchCore(kind: CoreKind): Promise<void> {
  if (running) return;
  setStatus(`recargando ${CORE_SPECS[kind].label}…`);
  await loadCore(kind);
  const cur = info;
  if (cur !== null) {
    if (cur.encoder === "libopus" && !cur.hasLibopus && cur.hasLibmp3lame) cur.encoder = "libmp3lame";
    if (cur.encoder === "libmp3lame" && !cur.hasLibmp3lame && cur.hasLibopus) cur.encoder = "libopus";
    cur.encoderChain = [...cur.encoderChain, `cambio manual de core → ${kind}`];
  }
  renderCoreInfo();
  publish();
  setStatus(`core activo: ${CORE_SPECS[kind].label}`);
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

function wireUi(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>("button[data-fixture]")) {
    const fixture = btn.dataset.fixture;
    if (fixture === undefined) continue;
    btn.addEventListener("click", () => {
      void runFixture(fixture);
    });
  }
  byId<HTMLButtonElement>("clean").addEventListener("click", () => {
    void cleanAll();
  });
  byId<HTMLButtonElement>("reload-core").addEventListener("click", () => {
    const sel = byId<HTMLSelectElement>("core-select").value;
    if (sel !== "st" && sel !== "mt") return;
    void switchCore(sel);
  });
}

async function init(): Promise<void> {
  window.__SPIKE_RESULTS__ = results;
  window.__SPIKE_INFO__ = null;
  window.__SPIKE_STATUS__ = { ready: false, running: false, current: null };
  restore();
  publish();
  wireUi();
  renderEnv();
  setStatus("cargando core y sondeando encoders…");
  try {
    await initEncoderChain();
    renderCoreInfo();
    renderEnv();
    publish();
    setStatus(`listo: ${info?.coreLabel ?? ""} + ${info?.encoder ?? ""}`);
  } catch (e) {
    setStatus(`ERROR al iniciar: ${msg(e)}`);
    pushLog(`ERROR al iniciar: ${msg(e)}`);
    publish();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init());
} else {
  void init();
}
