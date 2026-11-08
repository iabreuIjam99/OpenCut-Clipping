/**
 * Spike Whisper WebGPU (Task 7, Go/No-Go) — MonetizaClip.
 *
 * Pregunta: ¿se puede transcribir audio local-first (cero coste de API) con
 * `onnx-community/whisper-base` en Chrome de escritorio vía WebGPU, con
 * timestamps por palabra, WER medible y segunda carga en caliente < 2 s?
 *
 * API: `@huggingface/transformers` 4.3.2 — leída de README + types antes de
 * codificar: `pipeline(task, model, { revision, device, dtype, progress_callback })`
 * y `transcriber(audio, { return_timestamps, chunk_length_s, stride_length_s,
 * language, task })`. El `dtype` por fichero usa claves del registro de
 * sesiones (`model` en get_model_files / `encoder_model` en session.js); se
 * fijan AMBAS claves para que ambas rutas resuelvan igual (fp32) y no haya
 * descarga/carga con sufijos incoherentes.
 *
 * Resultados: `window.__WHISPER_RESULTS__` (JSON) + <pre id="results">.
 */
import {
  AutoConfig,
  AutoModelForSpeechSeq2Seq,
  AutoTokenizer,
  env,
  LogLevel,
  pipeline,
} from "@huggingface/transformers";
import type {
  AutomaticSpeechRecognitionOutput,
  AutomaticSpeechRecognitionPipeline,
  DataType,
  PretrainedModelOptions,
  ProgressInfo,
} from "@huggingface/transformers";
// Ronda 2 (F1/F4): mismo módulo que usa el bundle de transformers.js, así que
// parchear `InferenceSession.create`/`env.webgpu` afecta también a esa copia.
import { env as ortEnv, InferenceSession } from "onnxruntime-web/webgpu";
import sentencesFixture from "./fixtures/sentences.json";
import scriptText from "./fixtures/script.txt?raw";

// ---------------------------------------------------------------------------
// Constantes del modelo (R3: revisión pinneada)
// ---------------------------------------------------------------------------

const MODEL = "onnx-community/whisper-base";
const REVISION = "27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c";
const MODEL_LICENSE = "apache-2.0";
const BASE_MODEL = "openai/whisper-base";

/**
 * Modelo alternativo SOLO para la sonda de timestamps por palabra (R5).
 *
 * El export pineado en R3 no publica atenciones: se verificó leyendo los
 * últimos 128 KB de `decoder_model(.merged)(_fp16|_q4).onnx` (donde vive la
 * lista de salidas del grafo) y de los 123,602,419 B de `decoder_model_merged_q4.onnx`
 * en caché: aparecen `logits`/`present.*` pero NI `attentions` ni
 * `cross_attentions` → `return_timestamps: "word"` lanza «Model outputs must
 * contain cross attentions…» (huggingface/transformers.js). Este repo hermano
 * sí los exporta (`cross_attentions.N` en el grafo) y declara `alignment_heads`.
 * Licencia: cardData no declara `license` (base openai/whisper-base, MIT).
 */
const ALT_MODEL = "onnx-community/whisper-base_timestamped";
const ALT_REVISION = "608c49e61301901684bc36cac8f74b95ff6b5a8e";
const ALT_LICENSE = "sin `license` en cardData (base openai/whisper-base, MIT)";

/** Receta WebGPU recomendada: encoder fp32 + decoder q4 (ficheros en la revisión). */
const WEBGPU_DTYPE: Record<string, DataType> = {
  model: "fp32",
  encoder_model: "fp32",
  decoder_model_merged: "q4",
  decoder_model: "q4",
};

/** Fallback CPU: q8 (el default de dispositivo para `wasm`; sufijo `_quantized`). */
const WASM_DTYPE: Record<string, DataType> = {
  model: "q8",
  encoder_model: "q8",
  decoder_model_merged: "q8",
  decoder_model: "q8",
};

/** Opciones de generación fijas para todo el spike (inglés, transcripción). */
const LANG_OPTS = { language: "en", task: "transcribe" } as const;

// ---------------------------------------------------------------------------
// Tipos (strict, cero `any`)
// ---------------------------------------------------------------------------

type Device = "webgpu" | "wasm";
type RunKind =
  | "load-cold"
  | "load-warm"
  | "sentences-20"
  | "long-10min"
  | "wasm-fallback"
  // Ronda 2 (F1–F3): sonda de adaptadores, 10 min en adaptador alternativo,
  // timestamps de segmento y chunking manual.
  | "adapters"
  | "long-10min-altgpu"
  | "segments"
  | "manual-chunk";
type Outcome = "RUNNING" | "OK" | "ERROR" | "INTERRUPTED";

interface EnvInfo {
  userAgent: string;
  chromeVersion: string;
  deviceMemoryGB: number | null;
  hardwareConcurrency: number;
  crossOriginIsolated: boolean;
  jsHeapLimitMB: number;
  uasmAvailable: boolean;
}

interface WebGpuInfo {
  navigatorGpu: boolean;
  adapterAvailable: boolean;
  vendor: string | null;
  architecture: string | null;
  device: string | null;
  description: string | null;
  features: string[];
  maxBufferSize: number | null;
  maxStorageBufferBindingSize: number | null;
  maxComputeWorkgroupStorageSize: number | null;
  preferredCanvasFormat: string | null;
  error: string | null;
}

interface ModelInfo {
  repo: string;
  revision: string;
  license: string;
  baseModel: string;
  dtypeWebGpu: Record<string, string>;
  dtypeWasm: Record<string, string>;
  loadedDevice: Device | null;
  loadedLoadMs: number | null;
}

interface SpikeInfo {
  env: EnvInfo;
  webgpu: WebGpuInfo;
  model: ModelInfo;
  ready: boolean;
}

interface SpikeStatus {
  ready: boolean;
  running: boolean;
  current: RunKind | null;
}

interface PageBreakdownEntry {
  url: string;
  bytes: number;
  scope?: string;
  types?: string[];
}

interface HostBytes {
  host: string;
  transferBytes: number;
  payloadBytes: number;
  resources: number;
}

interface ResourceEntry {
  name: string;
  transferBytes: number;
  payloadBytes: number;
  durationMs: number;
}

interface DownloadStats {
  transferBytes: number;
  payloadBytes: number;
  hosts: HostBytes[];
  entries: ResourceEntry[];
}

interface ProgressFile {
  file: string;
  totalBytes: number | null;
  done: boolean;
}

/**
 * Acumulador global del `progress_total` de transformers.js: bytes totales
 * esperados y bytes ya servidos (red o caché). Fuente autoritativa de tamaño
 * de descarga: `PerformanceResourceTiming` de huggingface.co devuelve 0 porque
 * HF no envía `Timing-Allow-Origin` (ver `collectDownloads`).
 */
interface ProgressStats {
  totalBytes: number;
  loadedBytes: number;
}

interface WerSentence {
  index: number;
  ref: string;
  hyp: string;
  refWords: number;
  hypWords: number;
  errors: number;
  wer: number;
  rawErrors: number;
  rawWer: number;
  execMs: number;
}

interface WerReport {
  refWords: number;
  hypWords: number;
  errors: number;
  wer: number;
  rawErrors: number;
  rawWer: number;
  perSentence: WerSentence[] | null;
}

interface WordTimestamp {
  text: string;
  start: number | null;
  end: number | null;
}

interface TimestampReport {
  chunkCount: number;
  hypWords: number;
  coveredWords: number;
  coverage: number;
  monotonic: boolean;
  firstNonMonotonicIndex: number | null;
  /** Nº de pasos hacia atrás (0 = perfectamente monótono). */
  nonMonotonicCount: number;
  /** Mayor salto hacia atrás entre dos `start` consecutivos, en ms. */
  maxBackwardMs: number | null;
  invalidRanges: number;
  /** Valores de `start` distintos (detecta el bug «todo en 29.98 s»). */
  distinctStarts: number;
  /** Mayor proporción de chunks que comparten el mismo `start` (0..1). */
  duplicateStartShare: number;
  /** Chunks con `start`/`end` fuera de [0, duración del audio]. */
  outOfRange: number;
  /** Mediana de (end - start) en ms; 0 o1 ms indica timestamp degenerado. */
  medianSpanMs: number | null;
  sample: WordTimestamp[];
}

/** Resultado de un intento de timestamps por palabra sobre un modelo concreto. */
interface TimestampAttempt {
  model: string;
  revision: string;
  ok: boolean;
  error: string | null;
  execMs: number | null;
  report: TimestampReport | null;
}

/** Región del largometraje transcrita en aislamiento (diagnóstico de pérdidas). */
interface SliceDiagnostic {
  label: string;
  fromS: number;
  toS: number;
  execMs: number;
  text: string;
}

// ---------------------------------------------------------------------------
// Ronda 2 (F1–F4): adaptadores, timestamps de segmento, chunking manual y
// desglose de la carga en caliente.
// ---------------------------------------------------------------------------

/** Identidad de un adaptador WebGPU según `adapter.info` (F1). */
interface AdapterSummary {
  vendor: string | null;
  architecture: string | null;
  device: string | null;
  description: string | null;
  features: string[];
  maxBufferSize: number | null;
  maxStorageBufferBindingSize: number | null;
  maxComputeWorkgroupStorageSize: number | null;
}

type AdapterPref = "default" | "low-power" | "high-performance";

/** Resultado de `requestAdapter()` para una preferencia de energía concreta. */
interface AdapterChoice {
  pref: AdapterPref;
  ok: boolean;
  adapter: AdapterSummary | null;
  /** ¿Misma GPU que la elección «default»? (vendor+architecture+device+description) */
  sameAsDefault: boolean | null;
  /** `adapter.requestDevice()` real (mismo camino que usa ORT) + duración. */
  deviceRequestOk: boolean | null;
  deviceRequestMs: number | null;
  error: string | null;
}

interface AdapterProbeReport {
  choices: AdapterChoice[];
  /** GPUs distintas vistas (clave vendor/architecture/device/description). */
  distinctGpus: number;
  nonNvidiaPrefs: AdapterPref[];
  /** Mecanismo de selección observable (no existe script para chrome://gpu). */
  selectionMechanism: string;
  /** Adaptador forzado para la corrida `long-10min-altgpu` (si la hubo). */
  forcedPref: AdapterPref | null;
}

/** Segmento de nivel frase devuelto por `return_timestamps: true` (F2). */
interface SegmentInfo {
  start: number;
  end: number;
  text: string;
}

/**
 * Fronteras de segmento frente a los silencios reales del WAV: sirve para
 * juzgar si un corte de clip cae a ±0.5–1 s del lugar correcto.
 */
interface SilenceReport {
  frameMs: number;
  thresholdRms: number;
  minSpanMs: number;
  spanCount: number;
  spans: Array<{ startS: number; endS: number }>;
  /** Fronteras interiores evaluadas (fin del segmento i, i = 1..n-1). */
  boundaryCount: number;
  /** % de fronteras dentro de ±0.5 s / ±1.0 s de un silencio (o dentro). */
  within05Pct: number;
  within10Pct: number;
  /** % de silencios ≥ minSpanMs con alguna frontera dentro de ±0.5/±1.0 s. */
  recall05Pct: number;
  recall10Pct: number;
}

/** Análisis de una corrida con `return_timestamps: true` (F2). */
interface SegmentRunReport {
  ok: boolean;
  error: string | null;
  execMs: number;
  audioMs: number;
  segmentCount: number;
  /** Σ(end − start) en ms y su ratio frente a la duración del audio. */
  coveredMs: number;
  coverageRatio: number;
  monotonic: boolean;
  nonMonotonicCount: number;
  maxBackwardMs: number | null;
  invalidRanges: number;
  outOfRange: number;
  minDurationMs: number | null;
  medianDurationMs: number | null;
  p95DurationMs: number | null;
  maxDurationMs: number | null;
  text: string;
  /** WER del texto de segmentos contra la referencia (largo) o null. */
  werRef: WerPair | null;
  /** WER del texto de segmentos contra la MISMA corrida sin timestamps. */
  werVsNoTimestamp: WerPair | null;
  silence: SilenceReport | null;
  sample: SegmentInfo[];
  spreadSample: SegmentInfo[];
  segments: SegmentInfo[];
}

/** Ventana del chunking manual (F3). */
interface ManualWindowReport {
  index: number;
  startS: number;
  endS: number;
  execMs: number;
  wordsIn: number;
  /** Palabras de solape eliminadas al fusionar con la ventana anterior. */
  overlapWords: number;
  /** true si el solape exacto/fuzzy no se encontró (riesgo de duplicado). */
  overlapMiss: boolean;
  overlapFuzzy: boolean;
  wordsAfter: number;
  segmentCount: number;
  /** Segmentos de esta ventana con offsets absolutos (s) tras ajustar. */
  segments: SegmentInfo[];
}

interface WerOps {
  s: number;
  d: number;
  i: number;
}

interface ManualChunkReport {
  windowS: number;
  hopS: number;
  windowCount: number;
  usedSegmentTimestamps: boolean;
  windows: ManualWindowReport[];
  /** Σ de exec de ventanas (sin carga de audio ni merge). */
  totalExecMs: number;
  /** Wall completo de la corrida (carga WAV + ventanas + merge + WER). */
  totalWallMs: number;
  overlapHits: number;
  overlapFuzzyHits: number;
  overlapMisses: number;
  text: string;
  wer: WerPair;
  /** S/D/I del chunking manual contra la referencia (1431 palabras). */
  ops: WerOps;
  /** S/D/I de la corrida `long-10min` sin chunking (baseline 14.19 %). */
  baselineOps: WerOps | null;
  deletionsDelta: number | null;
}

/**
 * Desglose de `pipeline()` (F4). Los componentes se miden con
 * `performance.mark`/`measure` + hooks sobre Cache API, `fetch`,
 * `AutoTokenizer`/`AutoConfig`, `InferenceSession.create` y `requestDevice`.
 * `tokenizerWallMs` y `modelWallMs` se solapan (Promise.all en pipeline()).
 */
interface LoadBreakdown {
  totalMs: number;
  cacheReadSpanMs: number;
  cacheReadSumMs: number;
  cacheReadCount: number;
  cacheReadBytes: number;
  networkFetchCount: number;
  networkFetchSumMs: number;
  metadataFetchSumMs: number;
  configWallMs: number;
  tokenizerWallMs: number;
  tokenizerCacheMs: number;
  tokenizerParseMs: number;
  modelWallMs: number;
  modelCacheMs: number;
  modelOtherMs: number;
  /** Compilación/instantiación de wasm (ORT runtime) ⊂ modelOtherMs. */
  wasmCompileCount: number;
  wasmCompileMs: number;
  ortSessionCount: number;
  ortSessionMs: number;
  webgpuDeviceCount: number;
  webgpuDeviceMs: number;
  /** ortSessionMs − webgpuDeviceMs: grafo + compilación de pipelines WebGPU. */
  webgpuPipelineMs: number;
  /** total − (caché + parseo tokenizer + modelo + ORT + red); negativo = solapes. */
  residualMs: number;
  marks: string[];
}

interface WhisperResult {
  id: string;
  run: RunKind;
  device: Device;
  startedAt: string;
  model: string;
  revision: string;
  dtypeRecord: Record<string, string>;
  clearedCacheBefore: boolean | null;
  cacheNamesBefore: string[] | null;
  cacheNamesAfter: string[] | null;
  cacheBytesBefore: number | null;
  cacheBytesAfter: number | null;
  loadMs: number | null;
  downloads: DownloadStats | null;
  progressFiles: ProgressFile[] | null;
  progressTotalBytes: number | null;
  progressLoadedBytes: number | null;
  execMs: number | null;
  wallMs: number | null;
  audioFile: string | null;
  audioBytes: number | null;
  audioDurationMs: number | null;
  rtf: number | null;
  text: string | null;
  wer: WerReport | null;
  timestamps: TimestampReport | null;
  /** Intento R5 de timestamps por palabra con el modelo pineado (R3). */
  timestampsPinned: TimestampAttempt | null;
  /** Sonda con el modelo alternativo `_timestamped` (si el pineado falla). */
  timestampsAlt: TimestampAttempt | null;
  altLoadMs: number | null;
  altCacheBytesBefore: number | null;
  altCacheBytesAfter: number | null;
  /** Diagnóstico D: transcripción aislada de las regiones perdidas (ver RESULT.md). */
  sliceDiagnostics: SliceDiagnostic[] | null;
  sentenceReports: WerSentence[] | null;
  /** Ronda 2 — F1: identidad del adaptador usado en esta corrida. */
  adapter: AdapterSummary | null;
  /** Ronda 2 — F1: resultado de enumerar `requestAdapter()` por preferencia. */
  adapters: AdapterProbeReport | null;
  /** Ronda 2 — F1: adaptador forzado (corrida `long-10min-altgpu`). */
  forcedAdapter: AdapterSummary | null;
  /** Ronda 2 — F2: corrida con `return_timestamps: true` (10 min). */
  segmentReport: SegmentRunReport | null;
  /** Ronda 2 — F2: frases 01/03/08 con `return_timestamps: true`. */
  segmentSentences: SegmentRunReport[] | null;
  /** Ronda 2 — F3: chunking manual 30 s / solape 5 s con fusión LCP. */
  manualChunk: ManualChunkReport | null;
  /** Ronda 2 — F4: desglose de `pipeline()` (caché, ORT, WebGPU, tokenizer). */
  loadBreakdown: LoadBreakdown | null;
  peakJsHeapMB: number;
  peakPageMemoryMB: number | null;
  pageBreakdown: PageBreakdownEntry[];
  pageMemoryError: string | null;
  pageFinalBytes: number | null;
  pageFinalBreakdown: PageBreakdownEntry[];
  pageFinalError: string | null;
  pageSamples: number;
  pageRejected: number;
  pageFirstError: string | null;
  pageSampleIntervalMs: number | null;
  outcome: Outcome;
  error: string | null;
}

declare global {
  interface Window {
    __WHISPER_RESULTS__: WhisperResult[];
    __WHISPER_INFO__: SpikeInfo | null;
    __WHISPER_STATUS__: SpikeStatus;
  }
}

// `performance.memory` y `measureUserAgentSpecificMemory()` no están completos
// en lib.dom (Chrome 156 devuelve `{ bytes, breakdown }`).
type UasmResponse = ArrayBuffer | { bytes?: number; breakdown?: unknown };

const perfExt = performance as unknown as {
  readonly memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
  readonly measureUserAgentSpecificMemory?: () => Promise<UasmResponse>;
};

// ---------------------------------------------------------------------------
// Constantes de comportamiento
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;
const STORAGE_KEY = "monetizaclip.whisper-spike.v1";
const MAX_LOG_LINES = 5000;
const LOG_DROP_CHUNK = 500;
const UI_LOG_LINES = 200;
const MAX_AUDIO_BYTES = 128 * MB;
const SAMPLE_RATE = 16000;
const TICK_MS = 250;
const PERSIST_TICKS = 40;
const PAGE_MEM_START_MS = 2000;
const PAGE_MEM_MIN_MS = 1000;
const PAGE_MEM_MAX_MS = 30000;
const PAGE_FINAL_TIMEOUT_MS = 60000;

/** Hosts de descarga del modelo/binarios (R5.5: huggingface.co + cdn-lfs, + jsdelivr p/ ORT). */
const DOWNLOAD_HOST_RE = /huggingface\.co|hf\.co|jsdelivr\.net/;

/** MIME aceptados para los WAV de fixtures (validación estricta, R2 de rol). */
const ALLOWED_WAV_MIME: readonly string[] = [
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/vnd.wave",
  "application/octet-stream",
  "",
];

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
const results: WhisperResult[] = [];
let info: SpikeInfo | null = null;
let running = false;
let currentRun: RunKind | null = null;
const logLines: string[] = [];
let logPushCount = 0;
let lastLogRender = 0;
let logRenderTimer: number | null = null;
let audioCtx: OfflineAudioContext | null = null;

// Ronda 2 (F1): adaptador activo y preferencia forzada por `forceAdapter()`.
let activeAdapter: AdapterSummary | null = null;
let forcedAdapterPref: AdapterPref | null = null;
/** Prototipo de `GPUAdapter` capturado en la sonda inicial (para parchearlo). */
let gpuAdapterProto: object | null = null;
/** `navigator.gpu.requestAdapter` original, para restaurar tras forzar. */
let originalRequestAdapter: GPU["requestAdapter"] | null = null;

const wavUrls: Record<string, string> = import.meta.glob("/fixtures/*.wav", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

/** Referencia exacta del largometraje: script.txt tal cual (las 115 frases). */
const LONG_REF: string = scriptText
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .join(" ");

// ---------------------------------------------------------------------------
// Utilidades básicas
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

function fmtBytes(n: number): string {
  if (n >= 10 * 1024 * 1024) return `${round2(n / (1024 * 1024))} MiB (${n} B)`;
  if (n >= 1024 * 1024) return `${round2(n / MB)} MiB (${n} B)`;
  if (n >= 1024) return `${round2(n / 1024)} KiB (${n} B)`;
  return `${n} B`;
}

function setStatus(text: string): void {
  byId<HTMLElement>("status").textContent = text;
}

// ---------------------------------------------------------------------------
// Log (incluye el espejo de console para que los logs de transformers.js
// sean visibles en la página, R6)
// ---------------------------------------------------------------------------

function renderLog(): void {
  lastLogRender = performance.now();
  const pre = byId<HTMLPreElement>("log");
  const start = Math.max(0, logLines.length - UI_LOG_LINES);
  pre.textContent = logLines.slice(start).join("\n");
  pre.scrollTop = pre.scrollHeight;
}

function renderLogSoon(): void {
  if (performance.now() - lastLogRender > 200) {
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
  if (logLines.length >= MAX_LOG_LINES + LOG_DROP_CHUNK) {
    logLines.splice(0, logLines.length - MAX_LOG_LINES);
  }
  renderLogSoon();
}

function stringifyArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack ?? a.message;
  if (typeof a === "object" && a !== null) {
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }
  return String(a);
}

/** Espeja console.* hacia el <pre id="log"> sin perder la salida de DevTools. */
function mirrorConsole(): void {
  const wrap =
    (orig: (...data: unknown[]) => void, level: string) =>
    (...data: unknown[]): void => {
      pushLog(`[${level}] ${data.map(stringifyArg).join(" ")}`);
      orig(...data);
    };
  console.log = wrap(console.log.bind(console), "log");
  console.info = wrap(console.info.bind(console), "info");
  console.warn = wrap(console.warn.bind(console), "warn");
  console.error = wrap(console.error.bind(console), "error");
}

// ---------------------------------------------------------------------------
// Publicación + persistencia
// ---------------------------------------------------------------------------

function renderResults(): void {
  byId<HTMLPreElement>("results").textContent = JSON.stringify(results, null, 2);
}

function publish(): void {
  window.__WHISPER_RESULTS__ = results;
  window.__WHISPER_INFO__ = info;
  window.__WHISPER_STATUS__ = { ready: info?.ready === true, running, current: currentRun };
  renderResults();
}

let persistTimer: number | null = null;

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(results));
  } catch {
    // cuota superada: el resultado sigue visible en memoria
  }
}

function persistSoon(): void {
  if (persistTimer !== null) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    persist();
  }, 1000);
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
    for (const item of parsed as WhisperResult[]) {
      if (item.outcome === "RUNNING") {
        item.outcome = "INTERRUPTED";
        item.error = "la ejecución no terminó (recarga, crash de la pestaña o cierre)";
        recovered++;
      }
      item.sentenceReports ??= null;
      item.timestamps ??= null;
      item.wer ??= null;
      item.downloads ??= null;
      item.progressFiles ??= null;
      item.pageMemoryError ??= null;
      // Ronda 2: campos ausentes en resultados guardados por versiones previas.
      item.adapter ??= null;
      item.adapters ??= null;
      item.forcedAdapter ??= null;
      item.segmentReport ??= null;
      item.segmentSentences ??= null;
      item.manualChunk ??= null;
      item.loadBreakdown ??= null;
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
// Entorno + WebGPU
// ---------------------------------------------------------------------------

function buildEnv(): EnvInfo {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const m = /Chrome\/([\d.]+)/.exec(navigator.userAgent);
  return {
    userAgent: navigator.userAgent,
    chromeVersion: m?.[1] ?? "desconocida",
    deviceMemoryGB: nav.deviceMemory ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated: window.crossOriginIsolated,
    jsHeapLimitMB: round2((perfExt.memory?.jsHeapSizeLimit ?? 0) / MB),
    uasmAvailable: typeof perfExt.measureUserAgentSpecificMemory === "function",
  };
}

async function probeWebGpu(): Promise<WebGpuInfo> {
  const out: WebGpuInfo = {
    navigatorGpu: false,
    adapterAvailable: false,
    vendor: null,
    architecture: null,
    device: null,
    description: null,
    features: [],
    maxBufferSize: null,
    maxStorageBufferBindingSize: null,
    maxComputeWorkgroupStorageSize: null,
    preferredCanvasFormat: null,
    error: null,
  };
  if (!("gpu" in navigator) || navigator.gpu === undefined) {
    out.error = "navigator.gpu NO disponible en esta pestaña";
    return out;
  }
  out.navigatorGpu = true;
  try {
    out.preferredCanvasFormat = navigator.gpu.getPreferredCanvasFormat();
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter === null) {
      out.error = "navigator.gpu.requestAdapter() devolvió null (sin adaptador usable)";
      return out;
    }
    out.adapterAvailable = true;
    const ai = adapter.info;
    out.vendor = ai.vendor;
    out.architecture = ai.architecture;
    out.device = ai.device;
    out.description = ai.description;
    out.features = [...adapter.features].sort();
    out.maxBufferSize = adapter.limits.maxBufferSize;
    out.maxStorageBufferBindingSize = adapter.limits.maxStorageBufferBindingSize;
    out.maxComputeWorkgroupStorageSize = adapter.limits.maxComputeWorkgroupStorageSize;
    // Ronda 2 (F1): guardar identidad + prototipo (para forzar adaptador luego).
    activeAdapter = adapterSummary(adapter);
    gpuAdapterProto = Object.getPrototypeOf(adapter);
  } catch (e) {
    out.error = msg(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Caché + descargas
// ---------------------------------------------------------------------------

async function clearAllCaches(): Promise<string[]> {
  if (!("caches" in window)) return [];
  const keys = await caches.keys();
  for (const k of keys) await caches.delete(k);
  return keys;
}

/**
 * Tamaño en bytes de todo lo guardado en la Cache API (por fichero, vía
 * `blob().size`). Es la única cifra fiable de «cuánto modelo está en caché»:
 * `PerformanceResourceTiming.transferSize` de huggingface.co es 0 (sin cabecera
 * `Timing-Allow-Origin`), así que no sirve como medidor de descarga.
 */
async function cacheStorageBytes(): Promise<number> {
  if (!("caches" in window)) return 0;
  let total = 0;
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      try {
        const hit = await cache.match(request);
        if (hit !== undefined) total += (await hit.blob()).size;
      } catch {
        // Un fichero ilegible no invalida la medición total.
      }
    }
  }
  return total;
}

/** Suma PerformanceResourceTiming a huggingface.co / cdn-lfs / jsdelivr desde la última marca. */
function collectDownloads(): DownloadStats {
  const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
  const hosts = new Map<string, HostBytes>();
  const outEntries: ResourceEntry[] = [];
  let transferBytes = 0;
  let payloadBytes = 0;
  for (const e of entries) {
    if (!DOWNLOAD_HOST_RE.test(e.name)) continue;
    transferBytes += e.transferSize;
    payloadBytes += e.decodedBodySize;
    let host = "(url no parseable)";
    try {
      host = new URL(e.name).host;
    } catch {
      host = "(url no parseable)";
    }
    const acc = hosts.get(host) ?? { host, transferBytes: 0, payloadBytes: 0, resources: 0 };
    acc.transferBytes += e.transferSize;
    acc.payloadBytes += e.decodedBodySize;
    acc.resources += 1;
    hosts.set(host, acc);
    outEntries.push({
      name: e.name,
      transferBytes: e.transferSize,
      payloadBytes: e.decodedBodySize,
      durationMs: Math.round(e.duration),
    });
  }
  return { transferBytes, payloadBytes, hosts: [...hosts.values()], entries: outEntries };
}

function upsertProgressFile(map: Map<string, ProgressFile>, file: string): ProgressFile {
  const existing = map.get(file);
  if (existing !== undefined) return existing;
  const created: ProgressFile = { file, totalBytes: null, done: false };
  map.set(file, created);
  return created;
}

function makeProgressCollector(
  map: Map<string, ProgressFile>,
  stats: ProgressStats,
): (info: ProgressInfo) => void {
  return (info: ProgressInfo): void => {
    switch (info.status) {
      case "initiate":
      case "download": {
        upsertProgressFile(map, info.file);
        break;
      }
      case "progress": {
        const entry = upsertProgressFile(map, info.file);
        if (info.total > (entry.totalBytes ?? 0)) entry.totalBytes = info.total;
        break;
      }
      case "done": {
        const entry = upsertProgressFile(map, info.file);
        entry.done = true;
        pushLog(`cargado: ${info.file}${entry.totalBytes !== null ? ` (${fmtBytes(entry.totalBytes)})` : ""}`);
        break;
      }
      case "progress_total": {
        const totals = Object.entries(info.files);
        const doneCount = totals.filter(([, v]) => v.loaded >= v.total).length;
        const sumTotal = totals.reduce((acc, [, v]) => acc + v.total, 0);
        const sumLoaded = totals.reduce((acc, [, v]) => acc + v.loaded, 0);
        stats.totalBytes = Math.max(stats.totalBytes, sumTotal);
        stats.loadedBytes = Math.max(stats.loadedBytes, sumLoaded);
        pushLog(`progreso total: ${doneCount}/${totals.length} ficheros`);
        break;
      }
      case "ready": {
        pushLog("pipeline listo (status: ready)");
        break;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Audio (validación MIME + tamaño + magic bytes, R2 de rol)
// ---------------------------------------------------------------------------

function getAudioContext(): OfflineAudioContext {
  if (audioCtx === null) audioCtx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  return audioCtx;
}

interface LoadedAudio {
  data: Float32Array;
  bytes: number;
  durationMs: number;
}

async function loadAudio16k(url: string): Promise<LoadedAudio> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar ${url}`);
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!ALLOWED_WAV_MIME.includes(contentType)) {
    throw new Error(`MIME no permitido para audio: "${contentType}"`);
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) throw new Error(`audio vacío: ${url}`);
  if (buf.byteLength > MAX_AUDIO_BYTES) {
    throw new Error(`audio demasiado grande: ${buf.byteLength} B > ${MAX_AUDIO_BYTES} B`);
  }
  const view = new DataView(buf);
  if (
    view.byteLength < 12 ||
    view.getUint32(0, false) !== 0x52494646 || // "RIFF"
    view.getUint32(8, false) !== 0x57415645 // "WAVE"
  ) {
    throw new Error(`no es un WAV válido (magic bytes): ${url}`);
  }
  const ctx = getAudioContext();
  const audio = await ctx.decodeAudioData(buf);
  if (Math.abs(audio.sampleRate - SAMPLE_RATE) > 0.5) {
    throw new Error(`sample rate inesperado: ${audio.sampleRate} (esperado ${SAMPLE_RATE})`);
  }
  const data = audio.getChannelData(0).slice(0); // copia propia (libera el AudioBuffer)
  return { data, bytes: buf.byteLength, durationMs: Math.round(data.length / (SAMPLE_RATE / 1000)) };
}

function wavUrlFor(file: string): string {
  const url = wavUrls[`/fixtures/${file}`];
  if (url === undefined) throw new Error(`falta fixtures/${file} — ejecuta «bun run fixtures»`);
  return url;
}

// ---------------------------------------------------------------------------
// WER (normalizado + crudo) — Levenshtein sobre tokens
// ---------------------------------------------------------------------------

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokenize(s: string, normalize: boolean): string[] {
  const base = normalize ? normalizeText(s) : s;
  return base.split(/\s+/).filter((t) => t.length > 0);
}

function levenshtein(a: readonly string[], b: readonly string[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Uint32Array(n + 1);
  let cur = new Uint32Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= n; j++) {
      const cost = ai === b[j - 1] ? 0 : 1;
      // `?? 0` es solo para noUncheckedIndexedAccess: los índices están acotados.
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[n] ?? 0;
}

interface WerPair {
  refWords: number;
  hypWords: number;
  errors: number;
  wer: number;
  rawErrors: number;
  rawWer: number;
}

function computeWer(refRaw: string, hypRaw: string): WerPair {
  const refN = tokenize(refRaw, true);
  const hypN = tokenize(hypRaw, true);
  const errors = levenshtein(refN, hypN);
  const refR = tokenize(refRaw, false);
  const hypR = tokenize(hypRaw, false);
  const rawErrors = levenshtein(refR, hypR);
  return {
    refWords: refN.length,
    hypWords: hypN.length,
    errors,
    wer: refN.length > 0 ? errors / refN.length : 0,
    rawErrors,
    rawWer: refR.length > 0 ? rawErrors / refR.length : 0,
  };
}

function corpusWer(sentences: readonly WerSentence[]): WerPair {
  let refWords = 0;
  let hypWords = 0;
  let errors = 0;
  let rawErrors = 0;
  for (const s of sentences) {
    refWords += s.refWords;
    hypWords += s.hypWords;
    errors += s.errors;
    rawErrors += s.rawErrors;
  }
  return {
    refWords,
    hypWords,
    errors,
    wer: refWords > 0 ? errors / refWords : 0,
    rawErrors,
    rawWer: refWords > 0 ? rawErrors / refWords : 0,
  };
}

// ---------------------------------------------------------------------------
// Timestamps por palabra
// ---------------------------------------------------------------------------

function analyzeTimestamps(
  out: AutomaticSpeechRecognitionOutput,
  audioDurationMs: number | null = null,
): TimestampReport {
  const chunks = out.chunks ?? [];
  const hypWords = out.text.trim().split(/\s+/).filter((w) => w.length > 0);
  let covered = 0;
  let monotonic = true;
  let firstNonMonotonicIndex: number | null = null;
  let nonMonotonicCount = 0;
  let maxBackwardMs: number | null = null;
  let invalidRanges = 0;
  let outOfRange = 0;
  let prevStart = Number.NEGATIVE_INFINITY;
  const sample: WordTimestamp[] = [];
  const startCounts = new Map<number, number>();
  const spans: number[] = [];
  const durationS = audioDurationMs !== null ? audioDurationMs / 1000 : null;
  chunks.forEach((c, i) => {
    const ts: readonly (number | null)[] = c.timestamp;
    const start: number | null = ts[0] ?? null;
    const end: number | null = ts[1] ?? null;
    if (typeof start !== "number" || !Number.isFinite(start)) {
      invalidRanges += 1;
    } else {
      startCounts.set(start, (startCounts.get(start) ?? 0) + 1);
      if (start < prevStart) {
        monotonic = false;
        nonMonotonicCount += 1;
        const backward = Math.round((prevStart - start) * 1000);
        if (maxBackwardMs === null || backward > maxBackwardMs) maxBackwardMs = backward;
        if (firstNonMonotonicIndex === null) firstNonMonotonicIndex = i;
      }
      prevStart = start;
      if (typeof end === "number" && end < start) invalidRanges += 1;
      if (typeof end === "number" && Number.isFinite(end)) spans.push(Math.round((end - start) * 1000));
      if (
        durationS !== null &&
        ((typeof end === "number" && end > durationS + 0.5) || start > durationS + 0.5 || start < -0.5)
      ) {
        outOfRange += 1;
      }
    }
    const words = c.text.trim().split(/\s+/).filter((w) => w.length > 0);
    covered += words.length;
    if (sample.length < 10) sample.push({ text: c.text, start, end });
  });
  spans.sort((a, b) => a - b);
  const medianSpanMs = spans.length > 0 ? (spans[Math.floor(spans.length / 2)] ?? null) : null;
  const duplicateStartShare =
    startCounts.size > 0 && chunks.length > 0
      ? Math.max(...[...startCounts.values()]) / chunks.length
      : 0;
  return {
    chunkCount: chunks.length,
    hypWords: hypWords.length,
    coveredWords: covered,
    coverage: hypWords.length > 0 ? covered / hypWords.length : 0,
    monotonic,
    firstNonMonotonicIndex,
    nonMonotonicCount,
    maxBackwardMs,
    invalidRanges,
    distinctStarts: startCounts.size,
    duplicateStartShare: round2(duplicateStartShare),
    outOfRange,
    medianSpanMs,
    sample,
  };
}

// ---------------------------------------------------------------------------
// Memoria: measureUserAgentSpecificMedia (UASM) — mismo patrón que Task 6
// ---------------------------------------------------------------------------

function isRateLimitError(text: string): boolean {
  return /quota|cuota|securityerror|rate|frecuencia|limi/i.test(text);
}

interface SamplerState {
  intervalId: number;
  pageTimerId: number;
  pagePromise: Promise<void> | null;
  pageIntervalMs: number;
  execStart: number;
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
  result: WhisperResult;
}

let sampler: SamplerState | null = null;

function pushBreakdown(
  entries: unknown,
  inheritedUrl: string,
  inheritedScope: string | undefined,
  out: PageBreakdownEntry[],
): void {
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
      pushBreakdown(child, url, scope, out);
    } else {
      const entry: PageBreakdownEntry = { url, bytes };
      if (scope !== undefined) entry.scope = scope;
      if (types.length > 0) entry.types = types;
      out.push(entry);
    }
  }
}

function readMeasurement(res: UasmResponse): { bytes: number; breakdown: PageBreakdownEntry[] } | null {
  if (res instanceof ArrayBuffer) return { bytes: res.byteLength, breakdown: [] };
  if (typeof res !== "object" || res === null || typeof res.bytes !== "number") return null;
  const breakdown: PageBreakdownEntry[] = [];
  pushBreakdown(res.breakdown, "(sin url)", undefined, breakdown);
  return { bytes: res.bytes, breakdown };
}

async function samplePageMemory(st: SamplerState): Promise<void> {
  try {
    const fn = perfExt.measureUserAgentSpecificMemory;
    if (typeof fn !== "function") {
      if (st.pageErr === null) st.pageErr = "performance.measureUserAgentSpecificMemory() no disponible";
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
    st.pageIntervalMs = Math.max(PAGE_MEM_MIN_MS, Math.round(st.pageIntervalMs * 0.75));
  } catch (e) {
    const text = msg(e);
    st.pageRejected++;
    if (st.pageFirstError === null) st.pageFirstError = text;
    st.pageLastError = text;
    if (st.pageErr === null) st.pageErr = text;
    if (isRateLimitError(text)) {
      st.pageIntervalMs = Math.min(st.pageIntervalMs * 2, PAGE_MEM_MAX_MS);
      pushLog(`UASM rechazada #${st.pageRejected}: ${text} → intervalo ${st.pageIntervalMs} ms`);
    }
  }
}

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

function schedulePageSample(st: SamplerState): void {
  st.pageTimerId = window.setTimeout(() => {
    void takePageSample(st).then(() => {
      if (sampler === st) schedulePageSample(st);
    });
  }, st.pageIntervalMs);
}

async function takeFinalPageSample(result: WhisperResult): Promise<void> {
  const st = sampler;
  if (st === null) return;
  window.clearTimeout(st.pageTimerId);
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

function pageMb(peak: number | null): number | null {
  return peak !== null && Number.isFinite(peak) ? round2(peak / MB) : null;
}

function applySamplerToResult(st: SamplerState): void {
  const r = st.result;
  r.peakJsHeapMB = round2(st.peakJs / MB);
  r.peakPageMemoryMB = pageMb(st.peakPage);
  r.pageBreakdown = st.peakBreakdown;
  r.pageMemoryError = st.pageErr;
  r.pageSamples = st.pageSamples;
  r.pageRejected = st.pageRejected;
  r.pageFirstError = st.pageFirstError;
  r.pageSampleIntervalMs = st.pageIntervalMs;
}

function tick(st: SamplerState): void {
  const used = perfExt.memory?.usedJSHeapSize ?? 0;
  if (used > st.peakJs) st.peakJs = used;
  st.samples++;
  applySamplerToResult(st);
  if (st.samples % PERSIST_TICKS === 0) {
    persist();
    publish();
  }
  const elapsed = Math.round((performance.now() - st.execStart) / 1000);
  const state = document.getElementById("runstate");
  if (state !== null && currentRun !== null) {
    const uasm = st.lastPage !== null ? ` · UASM ${round2(st.lastPage / MB)} MB` : " · UASM pendiente";
    state.textContent = `RUNNING ${currentRun}: ${elapsed}s${uasm}`;
  }
}

function startSampler(result: WhisperResult): void {
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

function stopSampler(result: WhisperResult): void {
  const st = sampler;
  if (st === null) return;
  window.clearInterval(st.intervalId);
  window.clearTimeout(st.pageTimerId);
  sampler = null;
  const used = perfExt.memory?.usedJSHeapSize ?? 0;
  if (used > st.peakJs) st.peakJs = used;
  st.samples++;
  applySamplerToResult(st);
}

function lockExecClock(): void {
  if (sampler !== null) sampler.execLocked = true;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function updateButtons(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>("#controls button")) {
    btn.disabled = running;
  }
}

function writeMarker(r: WhisperResult): void {
  const parts: string[] = [`RUN_DONE: ${r.run} ${r.outcome}`];
  if (r.loadMs !== null) parts.push(`load=${Math.round(r.loadMs)}ms`);
  if (r.execMs !== null) parts.push(`exec=${Math.round(r.execMs)}ms`);
  if (r.rtf !== null) parts.push(`rtf=${r.rtf.toFixed(3)}`);
  if (r.wer !== null) parts.push(`wer=${(r.wer.wer * 100).toFixed(1)}%`);
  if (r.error !== null) parts.push(`error=${r.error}`);
  const div = document.createElement("div");
  div.id = `marker-${r.run}`;
  div.textContent = parts.join(" ");
  byId<HTMLElement>("markers").appendChild(div);
}

function renderEnv(): void {
  const e = info?.env;
  const w = info?.webgpu;
  const dl = byId<HTMLDListElement>("env");
  if (e === undefined || e === null) return;
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["Chrome", e.chromeVersion],
    ["userAgent", e.userAgent],
    ["navigator.deviceMemory", `${e.deviceMemoryGB ?? "?"} GB (cota declarada por el SO)`],
    ["hardwareConcurrency", String(e.hardwareConcurrency)],
    ["crossOriginIsolated (COOP/COEP)", String(e.crossOriginIsolated)],
    ["jsHeapSizeLimit", `${e.jsHeapLimitMB} MB`],
    ["UASM", e.uasmAvailable ? "measureUserAgentSpecificMemory() disponible" : "NO disponible"],
    ["navigator.gpu", w === undefined ? "sonda pendiente" : String(w.navigatorGpu)],
    ["adaptador WebGPU", w === undefined ? "sonda pendiente" : w.adapterAvailable ? "DISPONIBLE" : "NO DISPONIBLE"],
    [
      "adaptador info",
      w === undefined || !w.adapterAvailable
        ? (w?.error ?? "—")
        : `${w.vendor} / ${w.architecture} / ${w.device} — ${w.description}`,
    ],
    ["adaptador features", w === undefined ? "—" : w.features.join(", ") || "(vacío)"],
    [
      "límites adaptador",
      w === undefined || w.maxBufferSize === null
        ? "—"
        : `maxBufferSize ${fmtBytes(w.maxBufferSize)} · maxStorageBufferBindingSize ${fmtBytes(w.maxStorageBufferBindingSize ?? 0)} · workgroupStorage ${w.maxComputeWorkgroupStorageSize ?? 0} B`,
    ],
    ["preferredCanvasFormat", w?.preferredCanvasFormat ?? "—"],
  ];
  dl.replaceChildren(
    ...rows.map(([k, v]) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      const frag = document.createDocumentFragment();
      frag.append(dt, dd);
      return frag;
    }),
  );
}

function renderModelInfo(): void {
  const m = info?.model;
  const dl = byId<HTMLDListElement>("model-info");
  if (m === undefined || m === null) return;
  const lastLoad = [...results].reverse().find((r) => r.loadMs !== null && r.outcome === "OK");
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["repo", m.repo],
    ["revision (pinneada)", m.revision],
    ["licencia", m.license],
    ["base_model", m.baseModel],
    ["dtype WebGPU", Object.entries(m.dtypeWebGpu).map(([k, v]) => `${k}=${v}`).join(", ")],
    ["dtype WASM", Object.entries(m.dtypeWasm).map(([k, v]) => `${k}=${v}`).join(", ")],
    ["device cargado", m.loadedDevice ?? "—"],
    ["última carga", m.loadedLoadMs !== null ? `${Math.round(m.loadedLoadMs)} ms` : "—"],
    [
      "última descarga",
      lastLoad?.downloads != null
        ? `transfer ${fmtBytes(lastLoad.downloads.transferBytes)} · payload ${fmtBytes(lastLoad.downloads.payloadBytes)}`
        : "—",
    ],
  ];
  dl.replaceChildren(
    ...rows.map(([k, v]) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      const frag = document.createDocumentFragment();
      frag.append(dt, dd);
      return frag;
    }),
  );
}

// ---------------------------------------------------------------------------
// Ejecuciones
// ---------------------------------------------------------------------------

function makeResult(run: RunKind, device: Device): WhisperResult {
  return {
    id: `${run}-${Date.now()}`,
    run,
    device,
    startedAt: new Date().toISOString(),
    model: MODEL,
    revision: REVISION,
    dtypeRecord: { ...(device === "webgpu" ? WEBGPU_DTYPE : WASM_DTYPE) },
    clearedCacheBefore: null,
    cacheNamesBefore: null,
    cacheNamesAfter: null,
    cacheBytesBefore: null,
    cacheBytesAfter: null,
    loadMs: null,
    downloads: null,
    progressFiles: null,
    progressTotalBytes: null,
    progressLoadedBytes: null,
    execMs: null,
    wallMs: null,
    audioFile: null,
    audioBytes: null,
    audioDurationMs: null,
    rtf: null,
    text: null,
    wer: null,
    timestamps: null,
    timestampsPinned: null,
    timestampsAlt: null,
    altLoadMs: null,
    altCacheBytesBefore: null,
    altCacheBytesAfter: null,
    sliceDiagnostics: null,
    sentenceReports: null,
    adapter: activeAdapter,
    adapters: null,
    forcedAdapter: null,
    segmentReport: null,
    segmentSentences: null,
    manualChunk: null,
    loadBreakdown: null,
    peakJsHeapMB: 0,
    peakPageMemoryMB: null,
    pageBreakdown: [],
    pageMemoryError: null,
    pageFinalBytes: null,
    pageFinalBreakdown: [],
    pageFinalError: null,
    pageSamples: 0,
    pageRejected: 0,
    pageFirstError: null,
    pageSampleIntervalMs: null,
    outcome: "RUNNING",
    error: null,
  };
}

async function beginRun(result: WhisperResult): Promise<void> {
  running = true;
  currentRun = result.run;
  results.push(result);
  updateButtons();
  setStatus(`ejecutando ${result.run}…`);
  pushLog(`--- RUN ${result.run} (${result.device}, dtype ${JSON.stringify(result.dtypeRecord)})`);
  publish();
  persist();
  startSampler(result);
}

async function endRun(result: WhisperResult): Promise<void> {
  lockExecClock();
  await takeFinalPageSample(result);
  stopSampler(result);
  running = false;
  currentRun = null;
  updateButtons();
  const state = document.getElementById("runstate");
  if (state !== null) {
    state.textContent = `RUN ${result.run}: ${result.outcome}${result.error !== null ? ` — ${result.error}` : ""}`;
  }
  publish();
  persist();
  writeMarker(result);
  renderModelInfo();
}

/** Carga (fría o caliente) del pipeline en WebGPU. `clearCacheFirst` = R5.5(a). */
async function loadModel(clearCacheFirst: boolean): Promise<void> {
  if (running) {
    setStatus("ya hay una ejecución en curso");
    return;
  }
  const run: RunKind = clearCacheFirst ? "load-cold" : "load-warm";
  const result = makeResult(run, "webgpu");
  await beginRun(result);
  const wallStart = performance.now();
  // Ronda 2 (F4): hooks de medición alrededor de `pipeline()`.
  let hooks: LoadHooks | null = null;
  try {
    result.cacheNamesBefore = await caches.keys();
    if (clearCacheFirst) {
      const deleted = await clearAllCaches();
      result.clearedCacheBefore = true;
      pushLog(
        deleted.length > 0
          ? `Cache API borrada antes de la carga fría: ${deleted.join(", ")}`
          : "Cache API ya estaba vacía (carga fría real)",
      );
    } else {
      result.clearedCacheBefore = false;
    }
    performance.clearResourceTimings();
    result.cacheBytesBefore = await cacheStorageBytes();
    const progressFiles = new Map<string, ProgressFile>();
    const progressStats: ProgressStats = { totalBytes: 0, loadedBytes: 0 };
    if (transcriber !== null) {
      // Se libera el pipeline anterior ANTES de cronometrar (no medido).
      await transcriber.dispose();
      transcriber = null;
      pushLog("pipeline anterior dispuesto (dispose()) antes de la nueva carga");
    }
    const options: PretrainedModelOptions = {
      revision: REVISION,
      device: "webgpu",
      dtype: WEBGPU_DTYPE,
      progress_callback: makeProgressCollector(progressFiles, progressStats),
    };
    hooks = installLoadHooks();
    performance.mark("spike:load:start");
    const t0 = performance.now();
    const pipe = await pipeline("automatic-speech-recognition", MODEL, options);
    const loadMs = performance.now() - t0;
    performance.mark("spike:load:end");
    result.loadBreakdown = uninstallLoadHooks(hooks, loadMs);
    hooks = null;
    transcriber = pipe;
    result.loadMs = loadMs;
    result.progressFiles = [...progressFiles.values()];
    result.progressTotalBytes = progressStats.totalBytes;
    result.progressLoadedBytes = progressStats.loadedBytes;
    result.downloads = collectDownloads();
    result.cacheBytesAfter = await cacheStorageBytes();
    result.cacheNamesAfter = await caches.keys();
    result.outcome = "OK";
    if (info !== null) {
      info.model.loadedDevice = "webgpu";
      info.model.loadedLoadMs = loadMs;
      info.ready = true;
    }
    pushLog(
      `${run}: pipeline cargado en ${Math.round(loadMs)} ms · caché API ${
        fmtBytes(result.cacheBytesBefore ?? 0)
      } → ${fmtBytes(result.cacheBytesAfter ?? 0)} · transformers.js sirvió ${fmtBytes(
        progressStats.loadedBytes,
      )}/${fmtBytes(progressStats.totalBytes)} · transfer ${fmtBytes(
        result.downloads.transferBytes,
      )} (sin TAO en HF) · ${result.progressFiles.length} ficheros`,
    );
  } catch (e) {
    result.outcome = "ERROR";
    result.error = msg(e);
    pushLog(`ERROR en ${run}: ${result.error}`);
    setStatus(`${run}: ERROR — ${result.error}`);
  } finally {
    if (hooks !== null) discardLoadHooks(hooks);
    result.wallMs = Math.round(performance.now() - wallStart);
    await endRun(result);
    if (result.outcome === "OK") setStatus(`${run}: OK en ${Math.round(result.loadMs ?? 0)} ms`);
  }
}

// ---------------------------------------------------------------------------
// Sonda de timestamps por palabra (R5) — modelo pineado y alternativo
// ---------------------------------------------------------------------------

let altTranscriber: AutomaticSpeechRecognitionPipeline | null = null;

/**
 * Carga (una sola vez) el modelo alternativo `_timestamped` en WebGPU con la
 * misma receta que el pineado. Se registra carga y delta de caché para poder
 * documentar el tamaño de descarga en RESULT.md.
 */
async function loadAltPipeline(result: WhisperResult): Promise<AutomaticSpeechRecognitionPipeline> {
  if (altTranscriber !== null) return altTranscriber;
  const before = await cacheStorageBytes();
  const t0 = performance.now();
  pushLog(`cargando modelo alternativo ${ALT_MODEL} @ ${ALT_REVISION} (webgpu)…`);
  const pipe = await pipeline("automatic-speech-recognition", ALT_MODEL, {
    revision: ALT_REVISION,
    device: "webgpu",
    dtype: WEBGPU_DTYPE,
    progress_callback: makeProgressCollector(new Map<string, ProgressFile>(), {
      totalBytes: 0,
      loadedBytes: 0,
    }),
  });
  altTranscriber = pipe;
  result.altLoadMs = performance.now() - t0;
  result.altCacheBytesBefore = before;
  result.altCacheBytesAfter = await cacheStorageBytes();
  pushLog(
    `modelo alternativo listo en ${Math.round(result.altLoadMs)} ms · caché API ${fmtBytes(
      before,
    )} → ${fmtBytes(result.altCacheBytesAfter ?? 0)}`,
  );
  return pipe;
}

/**
 * Intento único de `return_timestamps: "word"` con chunk 30 / stride 5 (R5).
 * Nunca lanza: el error se captura en el intento para poder documentarlo.
 */
async function attemptWordTimestamps(
  pipe: AutomaticSpeechRecognitionPipeline,
  model: string,
  revision: string,
  audio: Float32Array,
  audioDurationMs: number | null,
): Promise<TimestampAttempt> {
  const t0 = performance.now();
  try {
    const out = await pipe(audio, {
      return_timestamps: "word",
      chunk_length_s: 30,
      stride_length_s: 5,
      ...LANG_OPTS,
    });
    return {
      model,
      revision,
      ok: true,
      error: null,
      execMs: performance.now() - t0,
      report: analyzeTimestamps(out, audioDurationMs),
    };
  } catch (e) {
    return {
      model,
      revision,
      ok: false,
      error: msg(e),
      execMs: performance.now() - t0,
      report: null,
    };
  }
}

/** R5.1 — 20 frases por separado + WER por frase y corpus (normalizado y crudo). */
async function runSentences(): Promise<void> {
  if (transcriber === null) {
    setStatus("carga el modelo primero (botón «Cargar modelo»)");
    return;
  }
  if (running) {
    setStatus("ya hay una ejecución en curso");
    return;
  }
  const pipe = transcriber;
  const result = makeResult("sentences-20", "webgpu");
  await beginRun(result);
  const wallStart = performance.now();
  try {
    const reports: WerSentence[] = [];
    let execTotal = 0;
    let audioBytes = 0;
    for (const s of sentencesFixture) {
      const audio = await loadAudio16k(wavUrlFor(s.file));
      audioBytes += audio.bytes;
      const t0 = performance.now();
      const out = await pipe(audio.data, LANG_OPTS);
      const execMs = performance.now() - t0;
      execTotal += execMs;
      const pair = computeWer(s.text, out.text);
      reports.push({
        index: s.index,
        ref: s.text,
        hyp: out.text,
        refWords: pair.refWords,
        hypWords: pair.hypWords,
        errors: pair.errors,
        wer: pair.wer,
        rawErrors: pair.rawErrors,
        rawWer: pair.rawWer,
        execMs: Math.round(execMs),
      });
      pushLog(
        `frase ${String(s.index).padStart(2, "0")} (${Math.round(execMs)} ms, WER ${(
          pair.wer * 100
        ).toFixed(1)}%): ${out.text.trim()}`,
      );
    }
    result.sentenceReports = reports;
    result.wer = { ...corpusWer(reports), perSentence: reports };
    result.execMs = execTotal;
    result.audioFile = "sentence-01..20.wav";
    result.audioBytes = audioBytes;
    result.audioDurationMs = sentencesFixture.reduce((acc, s) => acc + s.durationMs, 0);
    result.text = reports.map((r) => r.hyp).join("\n");
    result.outcome = "OK";
    pushLog(
      `sentences-20: WER normalizado ${(result.wer.wer * 100).toFixed(2)}% · crudo ${(
        result.wer.rawWer * 100
      ).toFixed(2)}% · ${result.wer.errors}/${result.wer.refWords} errores · exec total ${Math.round(
        execTotal,
      )} ms`,
    );

    // Sonda R5 de timestamps por palabra sobre sentence-01.
    const probe = sentencesFixture[0];
    if (probe !== undefined) {
      const probeAudio = await loadAudio16k(wavUrlFor(probe.file));
      result.timestampsPinned = await attemptWordTimestamps(
        pipe,
        MODEL,
        REVISION,
        probeAudio.data,
        probeAudio.durationMs,
      );
      pushLog(
        result.timestampsPinned.ok
          ? `timestamps sentence-01 (pineado): OK ${Math.round(
              result.timestampsPinned.execMs ?? 0,
            )} ms · cobertura ${((result.timestampsPinned.report?.coverage ?? 0) * 100).toFixed(1)}%`
          : `timestamps sentence-01 (pineado): ERROR — ${result.timestampsPinned.error}`,
      );
      if (result.timestampsPinned.ok) {
        result.timestamps = result.timestampsPinned.report;
      } else {
        try {
          const alt = await loadAltPipeline(result);
          result.timestampsAlt = await attemptWordTimestamps(
            alt,
            ALT_MODEL,
            ALT_REVISION,
            probeAudio.data,
            probeAudio.durationMs,
          );
          pushLog(
            result.timestampsAlt.ok
              ? `timestamps sentence-01 (alternativo): OK ${Math.round(
                  result.timestampsAlt.execMs ?? 0,
                )} ms · cobertura ${((result.timestampsAlt.report?.coverage ?? 0) * 100).toFixed(
                  1,
                )}% · ${result.timestampsAlt.report?.chunkCount ?? 0} palabras · distintos=${String(
                  result.timestampsAlt.report?.distinctStarts,
                )}`
              : `timestamps sentence-01 (alternativo): ERROR — ${result.timestampsAlt.error}`,
          );
          if (result.timestampsAlt.ok) result.timestamps = result.timestampsAlt.report;
        } catch (e) {
          pushLog(`ERROR en sonda del modelo alternativo: ${msg(e)}`);
        }
      }
    }
  } catch (e) {
    result.outcome = "ERROR";
    result.error = msg(e);
    pushLog(`ERROR en sentences-20: ${result.error}`);
    setStatus(`sentences-20: ERROR — ${result.error}`);
  } finally {
    result.wallMs = Math.round(performance.now() - wallStart);
    await endRun(result);
    if (result.outcome === "OK") {
      setStatus(`sentences-20: OK — WER ${(result.wer?.wer ?? 0) * 100}%`);
    }
  }
}

/** R5.2 — 10 min de audio, UNA vez, con return_timestamps: "word". */
async function runLong(): Promise<void> {
  if (transcriber === null) {
    setStatus("carga el modelo primero (botón «Cargar modelo»)");
    return;
  }
  if (running) {
    setStatus("ya hay una ejecución en curso");
    return;
  }
  const pipe = transcriber;
  const result = makeResult("long-10min", "webgpu");
  await beginRun(result);
  const wallStart = performance.now();
  try {
    const audio = await loadAudio16k(wavUrlFor("long-10min.wav"));
    result.audioFile = "long-10min.wav";
    result.audioBytes = audio.bytes;
    result.audioDurationMs = audio.durationMs;

    // A) Intento mandatario (R5): timestamps por palabra con el modelo pineado.
    result.timestampsPinned = await attemptWordTimestamps(
      pipe,
      MODEL,
      REVISION,
      audio.data,
      audio.durationMs,
    );
    pushLog(
      result.timestampsPinned.ok
        ? `long-10min A (timestamps, pineado): OK ${Math.round(
            result.timestampsPinned.execMs ?? 0,
          )} ms`
        : `long-10min A (timestamps, pineado): ERROR — ${result.timestampsPinned.error}`,
    );

    // B) Transcripción SIN timestamps → métrica primaria de R7 (exec/RTF/WER).
    const t0 = performance.now();
    const out = await pipe(audio.data, {
      chunk_length_s: 30,
      stride_length_s: 5,
      ...LANG_OPTS,
    });
    const execMs = performance.now() - t0;
    result.execMs = execMs;
    result.rtf = audio.durationMs > 0 ? execMs / audio.durationMs : null;
    result.text = out.text;
    const pair = computeWer(LONG_REF, out.text);
    result.wer = { ...pair, perSentence: null };
    result.outcome = "OK";
    pushLog(
      `long-10min B (sin timestamps): exec ${Math.round(execMs)} ms · RTF ${
        result.rtf?.toFixed(3) ?? "—"
      } · WER ${(pair.wer * 100).toFixed(2)}% · crudo ${(pair.rawWer * 100).toFixed(2)}% · ${
        pair.errors
      }/${pair.refWords} errores`,
    );

    // C) Si el pineado no expone atenciones → sonda con el modelo alternativo.
    if (result.timestampsPinned.ok) {
      result.timestamps = result.timestampsPinned.report;
      pushLog(
        `long-10min timestamps (pineado): cobertura ${(
          (result.timestamps?.coverage ?? 0) * 100
        ).toFixed(1)}% · monótono=${String(result.timestamps?.monotonic)}`,
      );
    } else {
      try {
        const alt = await loadAltPipeline(result);
        result.timestampsAlt = await attemptWordTimestamps(
          alt,
          ALT_MODEL,
          ALT_REVISION,
          audio.data,
          audio.durationMs,
        );
        if (result.timestampsAlt.ok && result.timestampsAlt.report !== null) {
          result.timestamps = result.timestampsAlt.report;
          const t = result.timestampsAlt.report;
          pushLog(
            `long-10min C (timestamps, alternativo): exec ${Math.round(
              result.timestampsAlt.execMs ?? 0,
            )} ms · ${t.chunkCount} palabras · cobertura ${(t.coverage * 100).toFixed(1)}% · monótono=${
              t.monotonic
            } · distintos=${t.distinctStarts} · share_dup=${t.duplicateStartShare} · fuera_rango=${
              t.outOfRange
            } · pasos_atras=${t.nonMonotonicCount} · max_atraso=${
              t.maxBackwardMs ?? "—"
            } ms · mediana_span=${t.medianSpanMs ?? "—"} ms`,
          );
        } else {
          pushLog(
            `long-10min C (timestamps, alternativo): ERROR — ${result.timestampsAlt?.error ?? "sin informe"}`,
          );
        }
      } catch (e) {
        pushLog(`ERROR en sonda C (modelo alternativo): ${msg(e)}`);
      }
    }

    // D) Diagnóstico: ¿la pérdida de palabras (WER 14%) es del modelo o del
    //    troceado? Se repiten en aislamiento las regiones que faltan en B.
    const regions: ReadonlyArray<{ label: string; fromS: number; toS: number }> = [
      { label: "D1 ref[268..364]", fromS: 105, toS: 150 },
      { label: "D2 ref[518..636]", fromS: 205, toS: 260 },
      { label: "D3 ref[1360..1398]", fromS: 545, toS: 568 },
    ];
    const diagnostics: SliceDiagnostic[] = [];
    for (const region of regions) {
      const start = Math.floor(region.fromS * SAMPLE_RATE);
      const end = Math.min(audio.data.length, Math.floor(region.toS * SAMPLE_RATE));
      if (end <= start) continue;
      const slice = audio.data.subarray(start, end);
      const tSlice = performance.now();
      const sliceOut = await pipe(slice, {
        chunk_length_s: 30,
        stride_length_s: 5,
        ...LANG_OPTS,
      });
      const entry: SliceDiagnostic = {
        label: region.label,
        fromS: region.fromS,
        toS: region.toS,
        execMs: Math.round(performance.now() - tSlice),
        text: sliceOut.text.trim(),
      };
      diagnostics.push(entry);
      pushLog(`${entry.label} (${region.fromS}-${region.toS} s): ${entry.text}`);
    }
    result.sliceDiagnostics = diagnostics;
  } catch (e) {
    result.outcome = "ERROR";
    result.error = msg(e);
    pushLog(`ERROR en long-10min: ${result.error}`);
    setStatus(`long-10min: ERROR — ${result.error}`);
  } finally {
    result.wallMs = Math.round(performance.now() - wallStart);
    await endRun(result);
    // Se libera el modelo alternativo tras la medición (no contamina el wasm).
    if (altTranscriber !== null) {
      await altTranscriber.dispose().catch(() => undefined);
      altTranscriber = null;
      pushLog("modelo alternativo dispuesto tras la medición");
    }
    if (result.outcome === "OK") {
      setStatus(
        `long-10min: OK — ${Math.round(result.execMs ?? 0)} ms (RTF ${result.rtf?.toFixed(3)})`,
      );
    }
  }
}

/** R5.6 — fallback wasm sobre sentence-01: tiempo + texto (no cuenta para el umbral). */
async function runWasmFallback(): Promise<void> {
  if (running) {
    setStatus("ya hay una ejecución en curso");
    return;
  }
  const result = makeResult("wasm-fallback", "wasm");
  await beginRun(result);
  const wallStart = performance.now();
  let wasmPipe: AutomaticSpeechRecognitionPipeline | null = null;
  try {
    result.cacheNamesBefore = await caches.keys();
    performance.clearResourceTimings();
    result.cacheBytesBefore = await cacheStorageBytes();
    const progressFiles = new Map<string, ProgressFile>();
    const progressStats: ProgressStats = { totalBytes: 0, loadedBytes: 0 };
    const options: PretrainedModelOptions = {
      revision: REVISION,
      device: "wasm",
      dtype: WASM_DTYPE,
      progress_callback: makeProgressCollector(progressFiles, progressStats),
    };
    const tLoad = performance.now();
    wasmPipe = await pipeline("automatic-speech-recognition", MODEL, options);
    result.loadMs = performance.now() - tLoad;
    result.progressFiles = [...progressFiles.values()];
    result.progressTotalBytes = progressStats.totalBytes;
    result.progressLoadedBytes = progressStats.loadedBytes;
    result.downloads = collectDownloads();
    result.cacheBytesAfter = await cacheStorageBytes();
    result.cacheNamesAfter = await caches.keys();

    const first = sentencesFixture[0];
    if (first === undefined) throw new Error("sentences.json no tiene frases");
    const audio = await loadAudio16k(wavUrlFor(first.file));
    result.audioFile = first.file;
    result.audioBytes = audio.bytes;
    result.audioDurationMs = audio.durationMs;
    const tExec = performance.now();
    const out = await wasmPipe(audio.data, LANG_OPTS);
    result.execMs = performance.now() - tExec;
    result.rtf = audio.durationMs > 0 ? result.execMs / audio.durationMs : null;
    result.text = out.text;
    const pair = computeWer(first.text, out.text);
    result.wer = { ...pair, perSentence: null };
    result.outcome = "OK";
    pushLog(
      `wasm-fallback: load ${Math.round(result.loadMs)} ms · exec ${Math.round(
        result.execMs,
      )} ms · "${out.text.trim()}"`,
    );
  } catch (e) {
    result.outcome = "ERROR";
    result.error = msg(e);
    pushLog(`ERROR en wasm-fallback: ${result.error}`);
    setStatus(`wasm-fallback: ERROR — ${result.error}`);
  } finally {
    result.wallMs = Math.round(performance.now() - wallStart);
    await endRun(result);
    // Se libera el pipeline wasm tras la medición UASM final (no duplica GPU/CPU).
    if (wasmPipe !== null) {
      await wasmPipe.dispose().catch(() => undefined);
      pushLog("pipeline wasm dispuesto tras la medición");
    }
    if (result.outcome === "OK") {
      setStatus(`wasm-fallback: OK — exec ${Math.round(result.execMs ?? 0)} ms`);
    }
  }
}

async function clearCacheAction(): Promise<void> {
  if (running) {
    setStatus("ya hay una ejecución en curso");
    return;
  }
  const keys = await clearAllCaches();
  pushLog(
    keys.length > 0
      ? `limpieza manual: ${keys.length} caché(s) borrada(s) — ${keys.join(", ")}`
      : "limpieza manual: no había cachés de Cache API",
  );
  setStatus(`caché limpiada (${keys.length} entradas)`);
  if (info !== null) publish();
}

// ---------------------------------------------------------------------------
// Ronda 2 (F1): sonda de adaptadores WebGPU y selección de GPU alternativa
// ---------------------------------------------------------------------------

function adapterSummary(adapter: GPUAdapter): AdapterSummary {
  const info = adapter.info;
  const features: string[] = [];
  for (const f of adapter.features) features.push(f);
  features.sort();
  return {
    vendor: info.vendor || null,
    architecture: info.architecture || null,
    device: info.device || null,
    description: info.description || null,
    features,
    maxBufferSize: adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
  };
}

function gpuKey(s: AdapterSummary): string {
  return [s.vendor, s.architecture, s.device, s.description].map((x) => x ?? "").join("|");
}

function sameGpu(a: AdapterSummary | null, b: AdapterSummary | null): boolean | null {
  if (a === null || b === null) return null;
  return gpuKey(a) === gpuKey(b);
}

/** Clasifica la GPU: ¿es del fabricante objetivo (NVIDIA) o no? */
function gpuClass(s: AdapterSummary): "nvidia" | "other" | "unknown" {
  const hay = `${s.vendor ?? ""} ${s.architecture ?? ""} ${s.device ?? ""} ${s.description ?? ""}`
    .toLowerCase()
    .trim();
  if (hay.replace(/\s+/g, "") === "") return "unknown";
  return /nvidia|geforce|quadro|tesla/.test(hay) ? "nvidia" : "other";
}

async function requestAdapterWithPref(pref: AdapterPref): Promise<GPUAdapter | null> {
  if (!("gpu" in navigator) || navigator.gpu === undefined) return null;
  const opts: GPURequestAdapterOptions | undefined =
    pref === "default" ? undefined : { powerPreference: pref };
  return await navigator.gpu.requestAdapter(opts);
}

/**
 * F1 — enumera `requestAdapter()` sin opciones y con `low-power` /
 * `high-performance`, registra `adapter.info` + límites y prueba
 * `requestDevice()` real (el mismo camino que usa ORT) para cada preferencia.
 */
async function runAdapterProbe(): Promise<void> {
  if (running) {
    setStatus("ya hay una ejecución en curso");
    return;
  }
  const result = makeResult("adapters", "webgpu");
  await beginRun(result);
  const wallStart = performance.now();
  try {
    if (!("gpu" in navigator) || navigator.gpu === undefined) {
      throw new Error("navigator.gpu no disponible en esta pestaña");
    }
    const prefs: AdapterPref[] = ["default", "low-power", "high-performance"];
    const choices: AdapterChoice[] = [];
    let defaultSummary: AdapterSummary | null = null;
    for (const pref of prefs) {
      const choice: AdapterChoice = {
        pref,
        ok: false,
        adapter: null,
        sameAsDefault: null,
        deviceRequestOk: null,
        deviceRequestMs: null,
        error: null,
      };
      try {
        const adapter = await requestAdapterWithPref(pref);
        if (adapter === null) throw new Error("requestAdapter() devolvió null");
        const summary = adapterSummary(adapter);
        choice.ok = true;
        choice.adapter = summary;
        if (pref === "default") defaultSummary = summary;
        // requestDevice real + destrucción del device (evita fugas de memoria).
        const t0 = performance.now();
        try {
          const device = await adapter.requestDevice();
          choice.deviceRequestOk = true;
          choice.deviceRequestMs = performance.now() - t0;
          device.destroy();
        } catch (de) {
          choice.deviceRequestOk = false;
          choice.deviceRequestMs = performance.now() - t0;
          choice.error = `requestDevice: ${msg(de)}`;
        }
      } catch (e) {
        choice.error = msg(e);
      }
      choices.push(choice);
    }
    for (const c of choices) {
      c.sameAsDefault = sameGpu(c.adapter, defaultSummary);
      if (c.adapter !== null) {
        pushLog(
          `adaptador ${c.pref}: ${c.adapter.vendor ?? "?"}/${c.adapter.architecture ?? "?"} — ` +
            `${c.adapter.description ?? "sin descripción"} · requestDevice ${
              c.deviceRequestOk === true ? `OK ${Math.round(c.deviceRequestMs ?? 0)} ms` : `FALLA (${c.error ?? "?"})`
            }`,
        );
      } else {
        pushLog(`adaptador ${c.pref}: NO DISPONIBLE — ${c.error ?? "sin error"}`);
      }
    }
    const keys = new Set<string>();
    for (const c of choices) if (c.adapter !== null) keys.add(gpuKey(c.adapter));
    const nonNvidiaPrefs = choices
      .filter((c) => c.adapter !== null && gpuClass(c.adapter) === "other")
      .map((c) => c.pref);
    // Preferencia que devuelve una GPU distinta de la «default» y no-NVIDIA.
    let forcedPref: AdapterPref | null = null;
    for (const c of choices) {
      if (c.pref !== "default" && c.adapter !== null && gpuClass(c.adapter) === "other" && c.sameAsDefault === false) {
        forcedPref = c.pref;
        break;
      }
    }
    if (forcedPref === null) {
      const def = choices.find((c) => c.pref === "default");
      if (def !== undefined && def.adapter !== null && gpuClass(def.adapter) === "other") {
        forcedPref = "default";
      }
    }
    forcedAdapterPref = forcedPref;
    const defChoice = choices.find((c) => c.pref === "default");
    if (defChoice !== undefined && defChoice.adapter !== null) activeAdapter = defChoice.adapter;
    const report: AdapterProbeReport = {
      choices,
      distinctGpus: keys.size,
      nonNvidiaPrefs,
      selectionMechanism:
        "no existe API de selección de GPU (chrome://gpu no es scriptable); la única palanca observable es " +
        `requestAdapter({powerPreference}) — ${keys.size} GPU distinta(s) vista(s) en ${
          choices.length
        } preferencia(s)`,
      forcedPref,
    };
    result.adapters = report;
    result.outcome = "OK";
    pushLog(
      `sonda de adaptadores: ${keys.size} GPU distinta(s) · no-NVIDIA en preferencias [${
        nonNvidiaPrefs.join(", ") || "ninguna"
      }] · forzable=${forcedPref ?? "NO"} · ${report.selectionMechanism}`,
    );
    setStatus(
      forcedPref !== null
        ? `adaptadores: hay GPU no-NVIDIA seleccionable (${forcedPref}) — corre «10 min en GPU alt»`
        : `adaptadores: todas las preferencias devuelven la misma GPU (${keys.size} distinta(s)) — sin alt GPU`,
    );
  } catch (e) {
    result.outcome = "ERROR";
    result.error = msg(e);
    pushLog(`ERROR en adapters: ${result.error}`);
    setStatus(`adapters: ERROR — ${result.error}`);
  } finally {
    result.wallMs = Math.round(performance.now() - wallStart);
    await endRun(result);
  }
}

// ---------------------------------------------------------------------------
// Ronda 2 (F1): forzar un adaptador no-NVIDIA para la corrida de 10 min
// ---------------------------------------------------------------------------

/** Instancia de `GPUAdapter` forzada (se mantiene para la recarga del pipeline). */
let forcedAdapterInstance: GPUAdapter | null = null;

/**
 * Parchea `navigator.gpu.requestAdapter` para que cualquier consumidor (ORT,
 * transformers.js) reciba SIEMPRE el adaptador de la preferencia pedida, y
 * limpia `env.webgpu.device` (reutilizaría el device antiguo) fijando
 * `env.webgpu.adapter`. Solo tiene efecto sobre sesiones creadas después.
 */
async function forceAdapter(pref: AdapterPref): Promise<GPUAdapter> {
  const adapter = await requestAdapterWithPref(pref);
  if (adapter === null) throw new Error(`requestAdapter(${pref}) devolvió null`);
  if (originalRequestAdapter === null) {
    originalRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  }
  const forced = adapter;
  navigator.gpu.requestAdapter = (async (): Promise<GPUAdapter> => forced) as GPU["requestAdapter"];
  if (ortEnv.webgpu !== undefined) {
    // `device` tipado raro en ort-common (TryGetGlobalType); se pasa por unknown.
    const w = ortEnv.webgpu as unknown as { adapter?: GPUAdapter; device?: GPUDevice };
    delete w.device; // el device previo (NVIDIA) no debe reutilizarse
    w.adapter = forced;
  }
  forcedAdapterInstance = forced;
  return adapter;
}

/** Restaura `navigator.gpu.requestAdapter`. `env.webgpu.adapter` queda con el
 * adaptador forzado a propósito: el pipeline ya vive en esa GPU y las próximas
 * sesiones deben seguir en la misma (documentado en RESULT.md). */
function restoreAdapter(): void {
  if (originalRequestAdapter !== null) {
    navigator.gpu.requestAdapter = originalRequestAdapter;
    originalRequestAdapter = null;
  }
}

/**
 * F1 — re-corre los 10 min SIN timestamps sobre el adaptador no-NVIDIA que
 * haya expuesto la sonda. Requiere recargar el pipeline: las sesiones ORT
 * existentes siguen atadas al device anterior.
 */
async function runLongAltAdapter(): Promise<void> {
  if (transcriber === null) {
    setStatus("carga el modelo primero (botón «Cargar modelo»)");
    return;
  }
  if (running) {
    setStatus("ya hay una ejecución en curso");
    return;
  }
  const result = makeResult("long-10min-altgpu", "webgpu");
  await beginRun(result);
  const wallStart = performance.now();
  try {
    const pref = forcedAdapterPref;
    if (pref === null) {
      throw new Error(
        "la sonda no encontró ninguna GPU no-NVIDIA seleccionable (todas las preferencias devuelven la misma GPU)",
      );
    }
    const forced = await forceAdapter(pref);
    const summary = adapterSummary(forced);
    result.forcedAdapter = summary;
    pushLog(`adaptador forzado (${pref}): ${summary.vendor}/${summary.architecture} — ${summary.description ?? ""}`);

    // Recarga del pipeline para que ORT cree sus sesiones con el device forzado.
    if (transcriber !== null) {
      await transcriber.dispose();
      transcriber = null;
      pushLog("pipeline dispuesto antes de recargar sobre el adaptador forzado");
    }
    const progressFiles = new Map<string, ProgressFile>();
    const progressStats: ProgressStats = { totalBytes: 0, loadedBytes: 0 };
    const tReload = performance.now();
    const pipe = await pipeline("automatic-speech-recognition", MODEL, {
      revision: REVISION,
      device: "webgpu",
      dtype: WEBGPU_DTYPE,
      progress_callback: makeProgressCollector(progressFiles, progressStats),
    });
    transcriber = pipe;
    result.altLoadMs = performance.now() - tReload;
    result.progressFiles = [...progressFiles.values()];
    result.progressTotalBytes = progressStats.totalBytes;
    result.progressLoadedBytes = progressStats.loadedBytes;
    activeAdapter = summary;
    pushLog(`pipeline recargado en ${Math.round(result.altLoadMs)} ms sobre el adaptador forzado`);

    // 10 min SIN timestamps (mismo protocolo que long-10min B).
    const audio = await loadAudio16k(wavUrlFor("long-10min.wav"));
    result.audioFile = "long-10min.wav";
    result.audioBytes = audio.bytes;
    result.audioDurationMs = audio.durationMs;
    const t0 = performance.now();
    const out = await pipe(audio.data, {
      chunk_length_s: 30,
      stride_length_s: 5,
      ...LANG_OPTS,
    });
    const execMs = performance.now() - t0;
    result.execMs = execMs;
    result.rtf = audio.durationMs > 0 ? execMs / audio.durationMs : null;
    result.text = out.text;
    const pair = computeWer(LONG_REF, out.text);
    result.wer = { ...pair, perSentence: null };
    result.outcome = "OK";
    pushLog(
      `altgpu 10min (${pref} ${summary.vendor}/${summary.architecture}): exec ${Math.round(execMs)} ms · RTF ${
        result.rtf?.toFixed(3) ?? "—"
      } · WER ${(pair.wer * 100).toFixed(2)}% · ${pair.errors}/${pair.refWords} errores`,
    );
    setStatus(
      `long-10min-altgpu: OK — exec ${Math.round(execMs)} ms · RTF ${result.rtf?.toFixed(3) ?? "—"}`,
    );
  } catch (e) {
    result.outcome = "ERROR";
    result.error = msg(e);
    pushLog(`ERROR en long-10min-altgpu: ${result.error}`);
    setStatus(`long-10min-altgpu: ERROR — ${result.error}`);
  } finally {
    restoreAdapter();
    result.wallMs = Math.round(performance.now() - wallStart);
    await endRun(result);
  }
}

// ---------------------------------------------------------------------------
// Ronda 2 (F2): timestamps de segmento (`return_timestamps: true`)
// ---------------------------------------------------------------------------

function failedSegmentReport(e: unknown, execMs: number, audioMs: number): SegmentRunReport {
  return {
    ok: false,
    error: msg(e),
    execMs,
    audioMs,
    segmentCount: 0,
    coveredMs: 0,
    coverageRatio: 0,
    monotonic: true,
    nonMonotonicCount: 0,
    maxBackwardMs: null,
    invalidRanges: 0,
    outOfRange: 0,
    minDurationMs: null,
    medianDurationMs: null,
    p95DurationMs: null,
    maxDurationMs: null,
    text: "",
    werRef: null,
    werVsNoTimestamp: null,
    silence: null,
    sample: [],
    spreadSample: [],
    segments: [],
  };
}

function analyzeSegments(
  out: AutomaticSpeechRecognitionOutput,
  execMs: number,
  audioMs: number,
  refText: string | null,
  plainText: string | null,
  audioData: Float32Array | null,
): SegmentRunReport {
  const chunks = out.chunks ?? [];
  const segments: SegmentInfo[] = [];
  let invalidRanges = 0;
  for (const c of chunks) {
    const s = c.timestamp[0];
    const e = c.timestamp[1];
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) {
      invalidRanges++;
      continue;
    }
    segments.push({ start: s, end: e, text: c.text });
  }
  const audioS = audioMs / 1000;
  let outOfRange = 0;
  let coveredMs = 0;
  let monotonic = true;
  let nonMonotonicCount = 0;
  let maxBackwardMs: number | null = null;
  const durations: number[] = [];
  let prevStart = Number.NEGATIVE_INFINITY;
  for (const seg of segments) {
    const durMs = (seg.end - seg.start) * 1000;
    durations.push(durMs);
    coveredMs += durMs;
    if (seg.start < -0.1 || seg.end > audioS + 0.1) outOfRange++;
    if (seg.start < prevStart) {
      monotonic = false;
      nonMonotonicCount++;
      const back = (prevStart - seg.start) * 1000;
      if (maxBackwardMs === null || back > maxBackwardMs) maxBackwardMs = back;
    }
    prevStart = Math.max(prevStart, seg.start);
  }
  durations.sort((a, b) => a - b);
  const n = durations.length;
  const minDurationMs = n > 0 ? durations[0] ?? null : null;
  const maxDurationMs = n > 0 ? durations[n - 1] ?? null : null;
  let medianDurationMs: number | null = null;
  if (n > 0) {
    medianDurationMs =
      n % 2 === 1
        ? durations[Math.floor(n / 2)] ?? null
        : ((durations[n / 2 - 1] ?? 0) + (durations[n / 2] ?? 0)) / 2;
  }
  const p95Idx = n > 0 ? Math.min(n - 1, Math.max(0, Math.ceil(0.95 * n) - 1)) : -1;
  const p95DurationMs = p95Idx >= 0 ? durations[p95Idx] ?? null : null;

  // Muestra «spread»: 5 segmentos repartidos por todo el audio.
  const spreadIdx = new Set<number>();
  if (n > 0) {
    for (let k = 0; k < 5; k++) spreadIdx.add(Math.round((k * (n - 1)) / 4));
  }
  const spreadSample = [...spreadIdx]
    .sort((a, b) => a - b)
    .map((i) => segments[i])
    .filter((s): s is SegmentInfo => s !== undefined);

  return {
    ok: true,
    error: null,
    execMs,
    audioMs,
    segmentCount: segments.length,
    coveredMs: Math.round(coveredMs),
    coverageRatio: audioMs > 0 ? coveredMs / audioMs : 0,
    monotonic,
    nonMonotonicCount,
    maxBackwardMs: maxBackwardMs !== null ? Math.round(maxBackwardMs) : null,
    invalidRanges,
    outOfRange,
    minDurationMs: minDurationMs !== null ? Math.round(minDurationMs) : null,
    medianDurationMs: medianDurationMs !== null ? Math.round(medianDurationMs) : null,
    p95DurationMs: p95DurationMs !== null ? Math.round(p95DurationMs) : null,
    maxDurationMs: maxDurationMs !== null ? Math.round(maxDurationMs) : null,
    text: out.text,
    werRef: refText !== null ? computeWer(refText, out.text) : null,
    werVsNoTimestamp: plainText !== null ? computeWer(plainText, out.text) : null,
    silence: audioData !== null ? analyzeSilences(audioData, segments) : null,
    sample: segments.slice(0, 10),
    spreadSample,
    segments,
  };
}

/**
 * Fronteras de segmento vs silencios reales del WAV: frames de 100 ms,
 * umbral `max(0.005, 0.25 × mediana RMS)`, tramos ≥ 400 ms. Sirve para juzgar
 * si un corte de clip cae a ±0.5–1 s del lugar correcto.
 */
function analyzeSilences(data: Float32Array, segments: SegmentInfo[]): SilenceReport {
  const frameMs = 100;
  const frameLen = Math.round((SAMPLE_RATE * frameMs) / 1000);
  const frameCount = Math.floor(data.length / frameLen);
  const rms: number[] = [];
  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    const base = i * frameLen;
    for (let j = 0; j < frameLen; j++) {
      const v = data[base + j] ?? 0;
      sum += v * v;
    }
    rms.push(Math.sqrt(sum / frameLen));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] ?? 0 : 0;
  const thresholdRms = Math.max(0.005, 0.25 * median);
  const minSpanMs = 400;
  const minFrames = Math.max(1, Math.ceil(minSpanMs / frameMs));
  const spans: Array<{ startS: number; endS: number }> = [];
  let runStart = -1;
  for (let i = 0; i <= rms.length; i++) {
    const quiet = i < rms.length && (rms[i] ?? Infinity) <= thresholdRms;
    if (quiet && runStart < 0) runStart = i;
    if (!quiet && runStart >= 0) {
      if (i - runStart >= minFrames) {
        spans.push({ startS: (runStart * frameMs) / 1000, endS: (i * frameMs) / 1000 });
      }
      runStart = -1;
    }
  }
  // Fronteras interiores: fin del segmento i, i = 0..n-2 (n-1 fronteras).
  const boundaries: number[] = [];
  for (let i = 0; i + 1 < segments.length; i++) {
    const seg = segments[i];
    if (seg !== undefined) boundaries.push(seg.end);
  }
  const dist = (p: number, s: { startS: number; endS: number }): number =>
    p < s.startS ? s.startS - p : p > s.endS ? p - s.endS : 0;
  let within05 = 0;
  let within10 = 0;
  for (const b of boundaries) {
    let best = Number.POSITIVE_INFINITY;
    for (const s of spans) best = Math.min(best, dist(b, s));
    if (best <= 0.5) within05++;
    if (best <= 1.0) within10++;
  }
  let recall05 = 0;
  let recall10 = 0;
  for (const s of spans) {
    let best = Number.POSITIVE_INFINITY;
    for (const b of boundaries) best = Math.min(best, dist(b, s));
    if (best <= 0.5) recall05++;
    if (best <= 1.0) recall10++;
  }
  const bc = boundaries.length;
  const sc = spans.length;
  return {
    frameMs,
    thresholdRms,
    minSpanMs,
    spanCount: sc,
    spans,
    boundaryCount: bc,
    within05Pct: bc > 0 ? (within05 / bc) * 100 : 0,
    within10Pct: bc > 0 ? (within10 / bc) * 100 : 0,
    recall05Pct: sc > 0 ? (recall05 / sc) * 100 : 0,
    recall10Pct: sc > 0 ? (recall10 / sc) * 100 : 0,
  };
}

/**
 * F2 — frases 01/03/08 + 10 min con `return_timestamps: true`. Compara el
 * texto resultante contra la referencia y contra la corrida SIN timestamps.
 */
async function runSegments(): Promise<void> {
  if (transcriber === null) {
    setStatus("carga el modelo primero (botón «Cargar modelo»)");
    return;
  }
  if (running) {
    setStatus("ya hay una ejecución en curso");
    return;
  }
  const pipe = transcriber;
  const result = makeResult("segments", "webgpu");
  await beginRun(result);
  const wallStart = performance.now();
  try {
    // A) Frases cortas con timestamps de segmento.
    const sentenceReports: SegmentRunReport[] = [];
    for (const idx of [1, 3, 8]) {
      const s = sentencesFixture.find((x) => x.index === idx);
      if (s === undefined) throw new Error(`falta la frase ${idx} en fixtures/sentences.json`);
      const audio = await loadAudio16k(wavUrlFor(s.file));
      const t0 = performance.now();
      try {
        const out = await pipe(audio.data, { return_timestamps: true, ...LANG_OPTS });
        const execMs = performance.now() - t0;
        const rep = analyzeSegments(out, execMs, audio.durationMs, s.text, null, audio.data);
        sentenceReports.push(rep);
        pushLog(
          `segments sentence-0${idx}: ${rep.segmentCount} segmentos · cobertura ${(
            rep.coverageRatio * 100
          ).toFixed(1)}% · monótono=${String(rep.monotonic)} · mediana ${
            rep.medianDurationMs ?? "?"
          } ms · ${Math.round(execMs)} ms`,
        );
      } catch (e) {
        sentenceReports.push(failedSegmentReport(e, performance.now() - t0, audio.durationMs));
        pushLog(`segments sentence-0${idx}: ERROR — ${msg(e)}`);
      }
    }
    result.segmentSentences = sentenceReports;

    // B) 10 min con timestamps de segmento.
    const audio = await loadAudio16k(wavUrlFor("long-10min.wav"));
    result.audioFile = "long-10min.wav";
    result.audioBytes = audio.bytes;
    result.audioDurationMs = audio.durationMs;

    // Texto SIN timestamps para el WER comparativo (corrida previa o aquí).
    let plainText: string | null = null;
    for (let i = results.length - 1; i >= 0; i--) {
      const r = results[i];
      if (r !== undefined && r.run === "long-10min" && r.outcome === "OK" && r.text !== null) {
        plainText = r.text;
        break;
      }
    }
    if (plainText === null) {
      const tp = performance.now();
      const outPlain = await pipe(audio.data, { chunk_length_s: 30, stride_length_s: 5, ...LANG_OPTS });
      const plainExecMs = performance.now() - tp;
      plainText = outPlain.text;
      pushLog(`segments: sin corrida long-10min previa — generada sin timestamps (${Math.round(plainExecMs)} ms)`);
    }

    const t1 = performance.now();
    let segReport: SegmentRunReport;
    try {
      const out = await pipe(audio.data, {
        return_timestamps: true,
        chunk_length_s: 30,
        stride_length_s: 5,
        ...LANG_OPTS,
      });
      segReport = analyzeSegments(out, performance.now() - t1, audio.durationMs, LONG_REF, plainText, audio.data);
    } catch (e) {
      segReport = failedSegmentReport(e, performance.now() - t1, audio.durationMs);
    }
    result.segmentReport = segReport;
    result.execMs = segReport.execMs;
    result.rtf = audio.durationMs > 0 ? segReport.execMs / audio.durationMs : null;
    if (segReport.ok) {
      result.text = segReport.text;
      if (segReport.werRef !== null) result.wer = { ...segReport.werRef, perSentence: null };
      result.outcome = "OK";
      pushLog(
        `segments 10min: ${segReport.segmentCount} segmentos · cobertura ${(
          segReport.coverageRatio * 100
        ).toFixed(1)}% · monótono=${String(segReport.monotonic)} (retrocesos ${
          segReport.nonMonotonicCount
        }, máx ${segReport.maxBackwardMs ?? 0} ms) · duración mediana ${
          segReport.medianDurationMs ?? "?"
        } / p95 ${segReport.p95DurationMs ?? "?"} ms · WER vs ref ${(
          (segReport.werRef?.wer ?? 0) * 100
        ).toFixed(2)}% · WER vs sin-timestamps ${((segReport.werVsNoTimestamp?.wer ?? 0) * 100).toFixed(2)}%`,
      );
      const sil = segReport.silence;
      if (sil !== null) {
        pushLog(
          `segments silencios: ${sil.spanCount} tramos ≥${sil.minSpanMs} ms · fronteras dentro de ±0.5 s ${sil.within05Pct.toFixed(
            1,
          )}% / ±1.0 s ${sil.within10Pct.toFixed(1)}% · recall ±0.5 s ${sil.recall05Pct.toFixed(1)}% / ±1.0 s ${sil.recall10Pct.toFixed(
            1,
          )}%`,
        );
      }
      setStatus(
        `segments: OK — ${segReport.segmentCount} segmentos · cobertura ${(
          segReport.coverageRatio * 100
        ).toFixed(1)}%`,
      );
    } else {
      result.outcome = "ERROR";
      result.error = segReport.error ?? "return_timestamps: true falló en los 10 min";
      pushLog(`segments 10min: ERROR — ${result.error}`);
      setStatus(`segments: ERROR — ${result.error}`);
    }
  } catch (e) {
    result.outcome = "ERROR";
    result.error = msg(e);
    pushLog(`ERROR en segments: ${result.error}`);
    setStatus(`segments: ERROR — ${result.error}`);
  } finally {
    result.wallMs = Math.round(performance.now() - wallStart);
    await endRun(result);
  }
}

// ---------------------------------------------------------------------------
// Ronda 2 (F3): chunking manual 30 s / solape 5 s + fusión de texto
// ---------------------------------------------------------------------------

/**
 * Mayor solape «sufijo(prev) = prefijo(next)»: primero exacto (k ≥ 4) y luego
 * fuzzy (k desde min(60, …) hasta 4, ≤ 15 % de tokens distintos). Un solape
 * menor que 4 tokens no es fiable en inglés corto, así que se declara miss.
 */
function findOverlap(
  acc: readonly string[],
  win: readonly string[],
): { count: number; fuzzy: boolean } {
  const maxK = Math.min(acc.length, win.length);
  for (let k = maxK; k >= 4; k--) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (acc[acc.length - k + j] !== win[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return { count: k, fuzzy: false };
  }
  const maxF = Math.min(maxK, 60);
  for (let k = maxF; k >= 4; k--) {
    const limit = Math.floor(k * 0.15);
    let mism = 0;
    for (let j = 0; j < k; j++) {
      if (acc[acc.length - k + j] !== win[j]) {
        mism++;
        if (mism > limit) break;
      }
    }
    if (mism <= limit) return { count: k, fuzzy: true };
  }
  return { count: 0, fuzzy: false };
}

/** S/D/I (sustituciones, delecciones, inserciones) con backtrace sobre la
 * matriz de Levenshtein; s+d+i = errores totales (mismo costo unitario). */
function werOps(ref: readonly string[], hyp: readonly string[]): WerOps {
  const m = ref.length;
  const n = hyp.length;
  const w = n + 1;
  const dp: Uint16Array[] = [];
  for (let i = 0; i <= m; i++) dp.push(new Uint16Array(w));
  const row0 = dp[0];
  if (row0 !== undefined) for (let j = 0; j <= n; j++) row0[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = dp[i];
    const prev = dp[i - 1];
    if (cur === undefined || prev === undefined) continue;
    cur[0] = i;
    const r = ref[i - 1];
    for (let j = 1; j <= n; j++) {
      const cost = r === hyp[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
  }
  let s = 0;
  let d = 0;
  let ins = 0;
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const cur = dp[i]?.[j] ?? 0;
    if (i > 0 && j > 0) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      if (cur === (dp[i - 1]?.[j - 1] ?? 0) + cost) {
        if (cost === 1) s++;
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && cur === (dp[i - 1]?.[j] ?? 0) + 1) {
      d++;
      i--;
      continue;
    }
    if (j > 0 && cur === (dp[i]?.[j - 1] ?? 0) + 1) {
      ins++;
      j--;
      continue;
    }
    // Inalcanzable con costos unitarios; degradación segura.
    if (i > 0) {
      d++;
      i--;
    } else {
      ins++;
      j--;
    }
  }
  return { s, d, i: ins };
}

/**
 * F3 — ventanas de 30 s con solape de 5 s, transcripción independiente por
 * ventana (timestamps de segmento si F2 funciona, si no offset conocido) y
 * fusión por solape de texto normalizado. Mide exec por ventana y total.
 */
async function runManualChunk(): Promise<void> {
  if (transcriber === null) {
    setStatus("carga el modelo primero (botón «Cargar modelo»)");
    return;
  }
  if (running) {
    setStatus("ya hay una ejecución en curso");
    return;
  }
  const pipe = transcriber;
  const result = makeResult("manual-chunk", "webgpu");
  await beginRun(result);
  const wallStart = performance.now();
  try {
    const audio = await loadAudio16k(wavUrlFor("long-10min.wav"));
    result.audioFile = "long-10min.wav";
    result.audioBytes = audio.bytes;
    result.audioDurationMs = audio.durationMs;
    const durS = audio.data.length / SAMPLE_RATE;
    const windowS = 30;
    const hopS = 25;

    // Ventanas: 0, 25, 50, …; la última se alinea al final del audio.
    const starts: number[] = [];
    for (let s = 0; s + windowS <= durS + 1e-6; s += hopS) starts.push(s);
    const last = starts[starts.length - 1] ?? 0;
    if (last + windowS < durS - 0.5) starts.push(Math.max(0, durS - windowS));

    const windows: ManualWindowReport[] = [];
    let acc: string[] = [];
    let useTs: boolean | null = null;
    let overlapHits = 0;
    let overlapFuzzyHits = 0;
    let overlapMisses = 0;
    let totalExec = 0;

    for (let i = 0; i < starts.length; i++) {
      const startS = starts[i] ?? 0;
      const endS = Math.min(startS + windowS, durS);
      const from = Math.round(startS * SAMPLE_RATE);
      const to = Math.round(endS * SAMPLE_RATE);
      const slice = audio.data.subarray(from, to);
      const t0 = performance.now();
      let text: string;
      let segs: SegmentInfo[];
      let out: AutomaticSpeechRecognitionOutput | null = null;
      if (useTs !== false) {
        try {
          out = await pipe(slice, { return_timestamps: true, ...LANG_OPTS });
        } catch (e) {
          useTs = false;
          pushLog(`chunk ventana ${i}: return_timestamps falló (${msg(e)}) → offset conocido`);
        }
      }
      if (out !== null) {
        useTs = true;
        text = out.text;
        segs = [];
        for (const c of out.chunks ?? []) {
          if (Number.isFinite(c.timestamp[0]) && Number.isFinite(c.timestamp[1])) {
            segs.push({ start: c.timestamp[0] + startS, end: c.timestamp[1] + startS, text: c.text });
          }
        }
      } else {
        const plain = await pipe(slice, LANG_OPTS);
        text = plain.text;
        segs = [{ start: startS, end: endS, text: plain.text }];
      }
      const execMs = performance.now() - t0;
      totalExec += execMs;

      const winTokens = tokenize(text, true);
      let overlap = 0;
      let fuzzy = false;
      let miss = false;
      if (i === 0) {
        acc = winTokens.slice();
      } else {
        const m = findOverlap(acc, winTokens);
        overlap = m.count;
        fuzzy = m.fuzzy;
        miss = m.count === 0;
        if (miss) overlapMisses++;
        else if (fuzzy) overlapFuzzyHits++;
        else overlapHits++;
        acc = acc.slice(0, acc.length - overlap).concat(winTokens);
      }
      windows.push({
        index: i,
        startS: round2(startS),
        endS: round2(endS),
        execMs: Math.round(execMs),
        wordsIn: winTokens.length,
        overlapWords: overlap,
        overlapMiss: miss,
        overlapFuzzy: fuzzy,
        wordsAfter: acc.length,
        segmentCount: segs.length,
        segments: segs,
      });
      pushLog(
        `chunk ventana ${i} [${round2(startS)}–${round2(endS)} s]: ${Math.round(execMs)} ms · ${
          winTokens.length
        } palabras · solape ${overlap}${fuzzy ? " (fuzzy)" : ""}${miss ? " (MISS)" : ""} → ${acc.length} acumuladas`,
      );
    }

    const mergedText = acc.join(" ");
    const pair = computeWer(LONG_REF, mergedText);
    result.text = mergedText;
    result.wer = { ...pair, perSentence: null };
    result.execMs = totalExec;
    result.rtf = audio.durationMs > 0 ? totalExec / audio.durationMs : null;
    const ops = werOps(tokenize(LONG_REF, true), acc);

    // Baseline: última corrida long-10min OK (S8/D194/I1 en la ronda 1).
    let baselineOps: WerOps | null = null;
    for (let i = results.length - 1; i >= 0; i--) {
      const r = results[i];
      if (r !== undefined && r !== result && r.run === "long-10min" && r.outcome === "OK" && r.text !== null) {
        baselineOps = werOps(tokenize(LONG_REF, true), tokenize(r.text, true));
        break;
      }
    }
    const deletionsDelta = baselineOps !== null ? ops.d - baselineOps.d : null;
    const totalWallMs = Math.round(performance.now() - wallStart);
    result.manualChunk = {
      windowS,
      hopS,
      windowCount: windows.length,
      usedSegmentTimestamps: useTs === true,
      windows,
      totalExecMs: Math.round(totalExec),
      totalWallMs,
      overlapHits,
      overlapFuzzyHits: overlapFuzzyHits,
      overlapMisses,
      text: mergedText,
      wer: pair,
      ops,
      baselineOps,
      deletionsDelta,
    };
    result.outcome = "OK";
    pushLog(
      `manual-chunk: ${windows.length} ventanas · exec total ${Math.round(totalExec)} ms · wall ${totalWallMs} ms · ` +
        `WER ${(pair.wer * 100).toFixed(2)}% · ops S${ops.s}/D${ops.d}/I${ops.i}` +
        (baselineOps !== null
          ? ` vs baseline S${baselineOps.s}/D${baselineOps.d}/I${baselineOps.i} (ΔD ${deletionsDelta ?? "?"})`
          : " (sin baseline long-10min)"),
    );
    setStatus(
      `manual-chunk: OK — WER ${(pair.wer * 100).toFixed(2)}% · exec ${Math.round(totalExec)} ms`,
    );
  } catch (e) {
    result.outcome = "ERROR";
    result.error = msg(e);
    pushLog(`ERROR en manual-chunk: ${result.error}`);
    setStatus(`manual-chunk: ERROR — ${result.error}`);
  } finally {
    result.wallMs = Math.round(performance.now() - wallStart);
    await endRun(result);
  }
}

// ---------------------------------------------------------------------------
// Ronda 2 (F4): hooks de medición alrededor de pipeline()
// ---------------------------------------------------------------------------

interface LoadHookWindow {
  t0: number;
  t1: number;
}

interface LoadHookState {
  marks: string[];
  cacheReads: Array<{ t0: number; t1: number; bytes: number }>;
  fetches: Array<{ t0: number; t1: number; metadata: boolean }>;
  config: LoadHookWindow | null;
  tokenizer: LoadHookWindow | null;
  model: LoadHookWindow | null;
  wasmCount: number;
  wasmMs: number;
  sessionCount: number;
  sessionMs: number;
  deviceCount: number;
  deviceMs: number;
}

interface LoadHooks {
  state: LoadHookState;
  restore: () => void;
}

/** Cabecera `Range` de una llamada a fetch (para identificar metadata probes). */
function rangeHeaderValue(input: RequestInfo | URL, init?: RequestInit): string | null {
  if (input instanceof Request) return input.headers.get("range");
  const h = init?.headers;
  if (h === undefined) return null;
  if (h instanceof Headers) return h.get("range");
  if (Array.isArray(h)) {
    for (const pair of h) {
      if ((pair[0] ?? "").toLowerCase() === "range") return pair[1] ?? null;
    }
    return null;
  }
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === "range") return v;
  }
  return null;
}

function isMetadataRange(input: RequestInfo | URL, init?: RequestInit): boolean {
  const r = rangeHeaderValue(input, init);
  return r !== null && r.replace(/\s+/g, "") === "bytes=0-0";
}

/**
 * Instala los wrappers de medición (F4): Cache API, fetch (transformers y
 * global), `AutoConfig`/`AutoTokenizer`/`AutoModelForSpeechSeq2Seq`,
 * `InferenceSession.create`, `WebAssembly.instantiate*` y `requestDevice`.
 * Devuelve `restore()` idempotente; `discardLoadHooks` solo restaura.
 */
function installLoadHooks(): LoadHooks {
  const state: LoadHookState = {
    marks: [],
    cacheReads: [],
    fetches: [],
    config: null,
    tokenizer: null,
    model: null,
    wasmCount: 0,
    wasmMs: 0,
    sessionCount: 0,
    sessionMs: 0,
    deviceCount: 0,
    deviceMs: 0,
  };
  const restores: Array<() => void> = [];
  let active = true;

  // 1) Cache.prototype.match → tiempo + bytes (content-length, best effort).
  const origMatch = Cache.prototype.match;
  Cache.prototype.match = function (
    this: Cache,
    request: RequestInfo | URL,
    options?: CacheQueryOptions,
  ): Promise<Response | undefined> {
    const t0 = performance.now();
    return origMatch.call(this, request, options).then((res) => {
      if (active) {
        let bytes = 0;
        const cl = res !== undefined ? res.headers.get("content-length") : null;
        if (cl !== null) bytes = Number.parseInt(cl, 10) || 0;
        state.cacheReads.push({ t0, t1: performance.now(), bytes });
      }
      return res;
    });
  };
  restores.push(() => {
    Cache.prototype.match = origMatch;
  });

  // 2) env.fetch (transformers) → red, separando probes de metadata (Range 0-0).
  const origEnvFetch = env.fetch;
  env.fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const t0 = performance.now();
    const res: Response = await origEnvFetch(input, init);
    if (active) state.fetches.push({ t0, t1: performance.now(), metadata: isMetadataRange(input, init) });
    return res;
  };
  restores.push(() => {
    env.fetch = origEnvFetch;
  });

  // 3) globalThis.fetch → ORT y cualquier otro consumidor fuera de env.fetch.
  const origGlobalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const t0 = performance.now();
    const res = await origGlobalFetch.call(globalThis, input, init);
    if (active) state.fetches.push({ t0, t1: performance.now(), metadata: isMetadataRange(input, init) });
    return res;
  };
  restores.push(() => {
    globalThis.fetch = origGlobalFetch;
  });

  // 4) Config/tokenizer/modelo: ventanas de wall para el desglose.
  type ConfigFT = typeof AutoConfig.from_pretrained;
  const origConfig: ConfigFT = AutoConfig.from_pretrained;
  AutoConfig.from_pretrained = (async (path: string, opts?: Parameters<ConfigFT>[1]) => {
    const t0 = performance.now();
    try {
      return await origConfig.call(AutoConfig, path, opts);
    } finally {
      if (active) state.config = { t0, t1: performance.now() };
    }
  }) as ConfigFT;
  restores.push(() => {
    AutoConfig.from_pretrained = origConfig;
  });

  type TokenizerFT = typeof AutoTokenizer.from_pretrained;
  const origTokenizer: TokenizerFT = AutoTokenizer.from_pretrained;
  AutoTokenizer.from_pretrained = (async (path: string, opts?: Parameters<TokenizerFT>[1]) => {
    const t0 = performance.now();
    try {
      return await origTokenizer.call(AutoTokenizer, path, opts);
    } finally {
      if (active) state.tokenizer = { t0, t1: performance.now() };
    }
  }) as TokenizerFT;
  restores.push(() => {
    AutoTokenizer.from_pretrained = origTokenizer;
  });

  type ModelFT = typeof AutoModelForSpeechSeq2Seq.from_pretrained;
  const origModel: ModelFT = AutoModelForSpeechSeq2Seq.from_pretrained;
  AutoModelForSpeechSeq2Seq.from_pretrained = (async (path: string, opts?: Parameters<ModelFT>[1]) => {
    const t0 = performance.now();
    try {
      return await origModel.call(AutoModelForSpeechSeq2Seq, path, opts);
    } finally {
      if (active) state.model = { t0, t1: performance.now() };
    }
  }) as ModelFT;
  restores.push(() => {
    AutoModelForSpeechSeq2Seq.from_pretrained = origModel;
  });

  // 5) Sesiones ORT (grafo + compilación de pipelines WebGPU).
  const origCreateTyped: typeof InferenceSession.create = InferenceSession.create;
  const origCreate = origCreateTyped as unknown as (...args: unknown[]) => Promise<InferenceSession>;
  InferenceSession.create = (async (...args: unknown[]) => {
    const t0 = performance.now();
    try {
      return await origCreate.apply(InferenceSession, args);
    } finally {
      if (active) {
        state.sessionCount++;
        state.sessionMs += performance.now() - t0;
      }
    }
  }) as unknown as typeof InferenceSession.create;
  restores.push(() => {
    InferenceSession.create = origCreateTyped;
  });

  // 6) Compilación/instantiación de wasm del runtime ORT.
  for (const fnName of ["instantiate", "instantiateStreaming"] as const) {
    const desc = Object.getOwnPropertyDescriptor(WebAssembly, fnName);
    if (desc === undefined || desc.value === undefined) continue;
    const orig = desc.value as (...args: unknown[]) => Promise<unknown>;
    Object.defineProperty(WebAssembly, fnName, {
      ...desc,
      value: (...args: unknown[]): Promise<unknown> => {
        const t0 = performance.now();
        return orig.apply(WebAssembly, args).then((r) => {
          if (active) {
            state.wasmCount++;
            state.wasmMs += performance.now() - t0;
          }
          return r;
        });
      },
    });
    restores.push(() => {
      Object.defineProperty(WebAssembly, fnName, desc);
    });
  }

  // 7) adapter.requestDevice() (prototipo capturado en probeWebGpu).
  const protoObj = gpuAdapterProto;
  if (protoObj !== null) {
    const desc = Object.getOwnPropertyDescriptor(protoObj, "requestDevice");
    if (desc !== undefined && typeof desc.value === "function") {
      const origRD = desc.value as (descriptor?: GPUDeviceDescriptor) => Promise<GPUDevice>;
      Object.defineProperty(protoObj, "requestDevice", {
        ...desc,
        value: function (this: GPUAdapter, descriptor?: GPUDeviceDescriptor): Promise<GPUDevice> {
          const t0 = performance.now();
          return origRD.call(this, descriptor).then((dev) => {
            if (active) {
              state.deviceCount++;
              state.deviceMs += performance.now() - t0;
            }
            return dev;
          });
        },
      });
      restores.push(() => {
        Object.defineProperty(protoObj, "requestDevice", desc);
      });
    }
  }

  return {
    state,
    restore: (): void => {
      if (!active) return;
      active = false;
      for (const r of restores) r();
    },
  };
}

/** Restaura todos los wrappers sin calcular nada (ruta de error). */
function discardLoadHooks(hooks: LoadHooks): void {
  hooks.restore();
}

/**
 * Restaura los wrappers, crea las `performance.measure` de las fases y
 * devuelve el desglose. `tokenizerWallMs` y `modelWallMs` se solapan
 * (Promise.all en pipeline()); las lecturas de caché se atribuyen a la ventana
 * en la que cayeron (pueden contar en ambas). El residuo puede ser negativo
 * cuando hay solapes (fetch de red dentro de las ventanas del modelo).
 */
function uninstallLoadHooks(hooks: LoadHooks, totalMs: number): LoadBreakdown {
  hooks.restore();
  const st = hooks.state;
  try {
    performance.measure("spike:load:total", "spike:load:start", "spike:load:end");
    st.marks.push("spike:load:total");
  } catch {
    // Sin marcas start/end no hay medida de total (no debería ocurrir).
  }
  const mk = (name: string, w: LoadHookWindow | null): void => {
    if (w === null) return;
    try {
      performance.measure(name, { start: w.t0, end: w.t1 });
      st.marks.push(name);
    } catch {
      // Medida inválida: se omite, no rompe la corrida.
    }
  };
  mk("spike:load:config", st.config);
  mk("spike:load:tokenizer", st.tokenizer);
  mk("spike:load:model", st.model);

  let cacheReadSumMs = 0;
  let cacheReadBytes = 0;
  let minT = Number.POSITIVE_INFINITY;
  let maxT = Number.NEGATIVE_INFINITY;
  for (const r of st.cacheReads) {
    cacheReadSumMs += r.t1 - r.t0;
    cacheReadBytes += r.bytes;
    minT = Math.min(minT, r.t0);
    maxT = Math.max(maxT, r.t1);
  }
  const cacheReadSpanMs = st.cacheReads.length > 0 ? maxT - minT : 0;
  const overlapWith = (w: LoadHookWindow | null): number => {
    if (w === null) return 0;
    let sum = 0;
    for (const r of st.cacheReads) {
      const o = Math.min(w.t1, r.t1) - Math.max(w.t0, r.t0);
      if (o > 0) sum += o;
    }
    return sum;
  };
  const configWallMs = st.config !== null ? st.config.t1 - st.config.t0 : 0;
  const tokenizerWallMs = st.tokenizer !== null ? st.tokenizer.t1 - st.tokenizer.t0 : 0;
  const tokenizerCacheMs = overlapWith(st.tokenizer);
  const tokenizerParseMs = tokenizerWallMs - tokenizerCacheMs;
  const modelWallMs = st.model !== null ? st.model.t1 - st.model.t0 : 0;
  const modelCacheMs = overlapWith(st.model);
  const modelOtherMs = modelWallMs - modelCacheMs - st.sessionMs;
  let networkFetchCount = 0;
  let networkFetchSumMs = 0;
  let metadataFetchSumMs = 0;
  for (const f of st.fetches) {
    if (f.metadata) metadataFetchSumMs += f.t1 - f.t0;
    else {
      networkFetchCount++;
      networkFetchSumMs += f.t1 - f.t0;
    }
  }
  const webgpuPipelineMs = st.sessionMs - st.deviceMs;
  const residualMs =
    totalMs - (cacheReadSumMs + tokenizerParseMs + modelOtherMs + st.sessionMs + networkFetchSumMs + metadataFetchSumMs);
  return {
    totalMs: round2(totalMs),
    cacheReadSpanMs: round2(cacheReadSpanMs),
    cacheReadSumMs: round2(cacheReadSumMs),
    cacheReadCount: st.cacheReads.length,
    cacheReadBytes,
    networkFetchCount,
    networkFetchSumMs: round2(networkFetchSumMs),
    metadataFetchSumMs: round2(metadataFetchSumMs),
    configWallMs: round2(configWallMs),
    tokenizerWallMs: round2(tokenizerWallMs),
    tokenizerCacheMs: round2(tokenizerCacheMs),
    tokenizerParseMs: round2(tokenizerParseMs),
    modelWallMs: round2(modelWallMs),
    modelCacheMs: round2(modelCacheMs),
    modelOtherMs: round2(modelOtherMs),
    wasmCompileCount: st.wasmCount,
    wasmCompileMs: round2(st.wasmMs),
    ortSessionCount: st.sessionCount,
    ortSessionMs: round2(st.sessionMs),
    webgpuDeviceCount: st.deviceCount,
    webgpuDeviceMs: round2(st.deviceMs),
    webgpuPipelineMs: round2(webgpuPipelineMs),
    residualMs: round2(residualMs),
    marks: st.marks,
  };
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

function wireUi(): void {
  byId<HTMLButtonElement>("btn-clear").addEventListener("click", () => void clearCacheAction());
  byId<HTMLButtonElement>("btn-load").addEventListener("click", () => void loadModel(true));
  byId<HTMLButtonElement>("btn-warm").addEventListener("click", () => void loadModel(false));
  byId<HTMLButtonElement>("btn-sentences").addEventListener("click", () => void runSentences());
  byId<HTMLButtonElement>("btn-long").addEventListener("click", () => void runLong());
  byId<HTMLButtonElement>("btn-wasm").addEventListener("click", () => void runWasmFallback());
  // Ronda 2 (F1–F3).
  byId<HTMLButtonElement>("btn-adapters").addEventListener("click", () => void runAdapterProbe());
  byId<HTMLButtonElement>("btn-segments").addEventListener("click", () => void runSegments());
  byId<HTMLButtonElement>("btn-chunk").addEventListener("click", () => void runManualChunk());
  byId<HTMLButtonElement>("btn-altgpu").addEventListener("click", () => void runLongAltAdapter());
}

async function init(): Promise<void> {
  window.__WHISPER_RESULTS__ = results;
  window.__WHISPER_INFO__ = null;
  window.__WHISPER_STATUS__ = { ready: false, running: false, current: null };
  mirrorConsole();
  env.useBrowserCache = true;
  env.logLevel = LogLevel.INFO;
  restore();
  publish();
  wireUi();
  setStatus("sondeando entorno y adaptador WebGPU…");
  const webgpu = await probeWebGpu();
  info = {
    env: buildEnv(),
    webgpu,
    model: {
      repo: MODEL,
      revision: REVISION,
      license: MODEL_LICENSE,
      baseModel: BASE_MODEL,
      dtypeWebGpu: { ...WEBGPU_DTYPE },
      dtypeWasm: { ...WASM_DTYPE },
      loadedDevice: null,
      loadedLoadMs: null,
    },
    ready: false,
  };
  renderEnv();
  renderModelInfo();
  publish();
  if (webgpu.navigatorGpu && webgpu.adapterAvailable) {
    setStatus(`listo — adaptador WebGPU ${webgpu.vendor}/${webgpu.architecture}; pulsa «Cargar modelo»`);
  } else {
    setStatus(`AVISO: sin adaptador WebGPU (${webgpu.error ?? "desconocido"}) — la carga fallará`);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init());
} else {
  void init();
}
