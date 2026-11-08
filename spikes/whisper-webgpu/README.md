# Spike: Whisper WebGPU (MonetizaClip)

Spike desechable (Task 7) que responde a la pregunta Go/No-Go: **¿se puede
transcribir audio local-first (cero coste de API) en Chrome de escritorio con
`onnx-community/whisper-base` sobre WebGPU — 10 min de audio en < 180 s, con
timestamps por palabra, WER medible y segunda carga en caliente < 2 s?**

**Resultado: ver [`RESULT.md`](./RESULT.md)** — veredicto GO/NO-GO incondicional
contra la tabla de umbrales de R7.

## Arranque

```powershell
cd spikes\whisper-webgpu
bun install                                   # dependencias propias del spike (pinned, sin ^ ni latest)
bun run fixtures                              # genera ./fixtures con SAPI "Microsoft Zira Desktop" (nunca descarga audio)
bun run dev                                   # http://localhost:5176  (strictPort; COOP/COEP/CORP)
bun run typecheck                             # tsc --noEmit → 0 errores
```

Requisitos de los fixtures: Windows con la voz **`Microsoft Zira Desktop`**
(en-US) instalada y `ffmpeg-static` (devDependency) para validar duraciones.
`fixtures/*.wav` está gitignored; `fixtures/script.txt` (texto original, CC0) y
`fixtures/sentences.json` (referencias exactas, generadas por el script) **sí**
se versionan — `.gitignore` excluye `fixtures/*` con esas dos excepciones.

El servidor Vite añade `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp` y `Cross-Origin-Resource-Policy:
cross-origin` en `server` **y** `preview` (necesarios para
`performance.measureUserAgentSpecificMemory()`).

## Protocolo de medición (botones, en orden)

1. **«Limpiar caché»** — borra todas las entradas de Cache API (incluida
   `transformers-cache`).
2. **«Cargar modelo (frío)»** — `pipeline()` con `device: "webgpu"`,
   `revision` pinneada y `dtype` encoder `fp32` + decoder `q4`. Mide
   `loadMs`, bytes (delta de Cache Storage **+** suma de `progress_callback`;
   ResourceTiming a `huggingface.co` no sirve: sin `Timing-Allow-Origin` el
   `transferSize` es 0) y ficheros descargados.
3. **«Cargar en caliente»** — **otro** `pipeline()` sin limpiar la caché
   (el anterior se `dispose()` primero, sin cronometrar). Umbral: < 2 s.
4. **«Transcribir 20 frases»** — `sentence-01..20.wav` por separado + WER
   (normalizado y crudo) por frase y corpus contra `sentences.json`.
5. **«Transcribir 10 min»** — cuatro fases sobre el mismo `long-10min.wav`:
   **(A)** timestamps con el modelo pineado (`return_timestamps: "word"`,
   `chunk_length_s: 30`, `stride_length_s: 5`) — falla si el ONNX no expone
   atenciones; **(B)** transcripción **sin** timestamps → `exec`, RTF y WER
   contra `script.txt` (métrica primaria de R7); **(C)** si A falló, sonda de
   timestamps con `onnx-community/whisper-base_timestamped` (revisión
   `608c49e61301901684bc36cac8f74b95ff6b5a8e`, solo timestamps, se `dispose()`
   al terminar); **(D)** diagnóstico: re-transcribe en aislamiento las 3
   regiones que B deja incompletas, para separar «pérdida por troceado» de
   «error del modelo».
6. **«Fallback wasm (sentence-01)»** — `device: "wasm"`, `dtype: q8`
   (ficheros `_quantized`); no cuenta para el umbral de tiempo.

### Ronda 2 (F1–F3)

7. **«Sonda de adaptadores (F1)»** — enumera `requestAdapter()` sin opciones,
   con `low-power` y con `high-performance`; registra `adapter.info` +
   límites, prueba un `requestDevice()` real por preferencia (y destruye el
   device) y decide si hay una GPU **no-NVIDIA** seleccionable para el
   botón 10. Deja `adapters` en el resultado.
8. **«Timestamps de segmento (F2)»** — frases 01/03/08 y los 10 min con
   `return_timestamps: true`: nº de segmentos, cobertura por **unión** de
   intervalos vs audio + huecos ≥100 ms (`uncovered`), monoticidad,
   distribución de duraciones (mediana/p95), **WER vs referencia (`werRef`,
   la columna del veredicto)** y un **diagnóstico transcript-vs-transcript**
   (`diagWerTranscriptVsTranscript`, no es vs referencia), y fronteras
   contra los silencios reales del WAV (±0.5 s / ±1.0 s). Deja
   `segmentSentences` y `segmentReport`.
9. **«Chunking manual (F3)»** — ventanas de 30 s con solape de 5 s (la
   última alineada al final), transcripción independiente con timestamps de
   segmento (offset conocido si F2 fallara) y fusión por solape de texto
   normalizado (`acc.concat(win.slice(k))`, exacto k ≥ 2, luego fuzzy ≤15 %);
   devuelve WER + S/D/I contra la corrida baseline de 10 min. Deja
   `manualChunk`.
10. **«10 min en adaptador alternativo (F1)»** — solo tiene sentido si la
    sonda encontró una GPU no-NVIDIA: fuerza `navigator.gpu.requestAdapter`,
    limpia `env.webgpu.device`, recarga el pipeline y repite los 10 min sin
    timestamps. Si no la hay, deja un resultado `ERROR` con el motivo
    (evidencia machine-readable). Deja `forcedAdapter`.

### Ronda 3 (F2–F4)

11. **«Carga sin remoto (F4)»** — sonda en dos fases (corrida `load-local`):
    **(a)** `local-only` **primero**, con `env.allowRemoteModels = false`,
    `env.allowLocalModels = true` y `env.localModelPath = "/models/"` en un
    contexto JS fresco (el caso más exigente: si la Cache API tiene los
    ficheros, la carga no hace ninguna petición a huggingface.co/cdn-lfs);
    **(b)** `warm-default` con los flags por defecto restaurados. Cuenta
    peticiones a HF vía `PerformanceResourceTiming` y intentos a `/models/`
    por fase; los flags se restauran al terminar. Deja `localLoad`
    (`phases[]` + `alternatives`). El umbral < 3 s (R12) no se toca.

Además, al **cargar la página** corre automáticamente el autochequeo F3
(corrida `selfcheck`, sin inferencia): `findOverlap` + merge con
`acc = "a b c d e"` + `win = "d e f g"` debe producir `"a b c d e f g"`
(k=2 exacto) más un caso sin solape; se publica en `__WHISPER_RESULTS__`
(`result.selfCheck.passed`).

La «Cargar en caliente» de la Ronda 2 instala además hooks de medición
(`loadBreakdown`): Cache API, `fetch`, estáticas de `AutoConfig`/
`AutoTokenizer`/`AutoModelForSpeechSeq2Seq`, `InferenceSession.create`,
`WebAssembly.instantiate*` y `requestDevice` — todo restaurado al terminar.

Cada ejecución muestra su tiempo en vivo, su medición UASM final (con desglose
por URL) y un marcador `RUN_DONE: …` en la página.

## Automatización (hooks)

- `window.__WHISPER_RESULTS__` — array JSON con todos los resultados
  (`load-cold`, `load-warm`, `sentences-20`, `long-10min`, `wasm-fallback`,
  `adapters`, `segments`, `manual-chunk`, `long-10min-altgpu`, `selfcheck`,
  `load-local`):
  `loadMs`, `execMs`, `rtf`, `wer` (normalizado + crudo + por frase),
  `timestamps` (cobertura, monotonía, muestra de 10 palabras), `downloads`
  (bytes transferidos/payload por host), `progressFiles`, `peakPageMemoryMB`,
  `pageFinalBytes` + `pageFinalBreakdown` (UASM), `outcome`, `error`, …
- `window.__WHISPER_INFO__` — entorno, sonda `navigator.gpu`/adaptador
  (`info.vendor`, `architecture`, features, límites) y modelo (repo, revisión,
  licencia, dtypes).
- `window.__WHISPER_STATUS__` — `{ ready, running, current }`.
- `#markers` — una línea por ejecución: `RUN_DONE: <run> OK|ERROR load=…ms
  exec=…ms rtf=… wer=…%`.
- `#results` — el mismo JSON volcado en un `<pre>` visible; `#log` — logs de
  transformers.js, progreso de descarga y `console.*` espejados.
- Los resultados se persisten en `localStorage` (`monetizaclip.whisper-spike.v1`);
  una recarga con una corrida a medias la deja como `INTERRUPTED`. **La
  automatización debe hacer `localStorage.clear()` al inicio** para no heredar
  resultados de sesiones anteriores.

## Sonda de timestamps (modelo alternativo)

La exportación ONNX pineada de `onnx-community/whisper-base`
(`27a07b4b…`) **no incluye salidas de atención**: se verificó escaneando los
bytes del `decoder_model_merged_q4.onnx` cacheado y los extremos del fichero
en HF (solo existen tensores `logits` y `present.*`, sin `cross_attentions.N`).
Por eso `return_timestamps: "word"` falla con
*"Model outputs must contain cross attentions…"*.

Para poder responder a R5.3 se usa el repo hermano
`onnx-community/whisper-base_timestamped`
(revisión `608c49e61301901684bc36cac8f74b95ff6b5a8e`, que sí expone
`cross_attentions.N` + `alignment_heads`) **solo** en las fases de timestamps;
nunca aporta `exec`/RTF/WER, se carga bajo demanda (`loadAltPipeline()`) y se
`dispose()` al terminar `long-10min`. Su tarjeta HF **no declara `license`**
(el modelo base `openai/whisper-base` es MIT) — riesgo documentado en
`RESULT.md`.

## Estructura

| Archivo | Papel |
|---|---|
| `main.ts` | lógica del spike: sonda WebGPU, cargas fría/caliente, corridas de transcripción, WER, timestamps, muestreo UASM, UI |
| `index.html` | página y controles (11 botones), paneles de entorno/modelo/log |
| `vite.config.ts` | headers COOP/COEP/CORP, puerto 5176 strict en `server` y `preview` |
| `scripts/gen-audio.ps1` | corpus SAPI: 20 frases + `long-10min.wav` (540-660 s validados con `ffmpeg-static`) + `sentences.json` |
| `fixtures/script.txt` | texto de referencia (original, CC0), 115 frases / 1431 palabras, una frase por línea |
| `fixtures/sentences.json` | referencias exactas de las 20 frases (generado, versionado) |
| `package.json`, `bun.lock`, `tsconfig.json` | dependencias y build propios del spike |
| `RESULT.md` | informe completo: entorno, métricas, WER, memoria, caché, **veredicto GO/NO-GO** (R7) |

## Restricciones respetadas

- Autocontenido en `spikes/whisper-webgpu/`: cero cambios en `apps/*`, raíz,
  `bunfig.toml`, `biome.json`, `.moon/` ni en el spike de Task 6; sin `moon ci`.
- Dependencias **fijadas a versión exacta** (`@huggingface/transformers@4.3.2`,
  `vite@6.4.5`, `typescript@5.9.3`, `ffmpeg-static@5.3.0`,
  `@types/node@22.20.5`, `@webgpu/types@0.1.74`).
- Modelo siempre con `revision: "27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c"`.
- `node_modules/`, `fixtures/*.wav`, `dist/`, `public/models/` y `*.log` **no
  se commitean** (tampoco pesos del modelo ni audio).
