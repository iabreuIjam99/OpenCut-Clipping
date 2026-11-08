# RESULT — Task 7: Spike Whisper WebGPU (Go/No-Go)

> **VEREDICTO GLOBAL: NO-GO** para el modo local por defecto tal como está
> medido hoy. De las 6 filas de la tabla R7: **4 GO · 2 NO-GO**
> (timestamps monótonos y segunda carga < 2 s). El throughput, la calidad y la
> pestaña sí cumplen con holgura; el plan alternativo está en §12.

Ejecutado con `chrome-devtools` MCP sobre la página real (puerto 5176,
`crossOriginIsolated: true`); no hizo falta `RUNBOOK.md`.

---

## 1. Entorno de medición

| Campo | Valor |
|---|---|
| Fecha | 2026-11-07 (local) / corridas 2026-11-08T02:03Z → 03:29Z (UTC) |
| Navegador | Chrome **156.0.0.0** (Windows x64) |
| Memoria / CPU | `deviceMemory` 32 GB · `hardwareConcurrency` 12 · `jsHeapLimit` 4,192 MB |
| Aislamiento | `crossOriginIsolated: true` — COOP `same-origin`, COEP `require-corp`, CORP `cross-origin` verificados en `/` **y** en el asset JS, en `server` y `preview` |
| `navigator.gpu` | disponible · `requestAdapter()` → **ok** |
| Adaptador | `adapter.info.vendor = "nvidia"`, `architecture = "blackwell"` (features: `shader-f16`, `subgroups`, `timestamp-query`, …; `maxBufferSize` 2,147,483,648 B; `maxStorageBufferBindingSize` 2,147,483,644 B) |
| Origen del vendor | `adapter.info` capturado en `__WHISPER_INFO__.webgpu` (el código no fija `powerPreference` distinta por defecto) |

⚠️ **Discrepancia honesta:** el brief describe una «GPU media» (iGPU AMD); el
adaptador expuesto por el navegador de automatización es `nvidia/blackwell`.
Todas las cifras de este informe salen de **ese** adaptador. En un iGPU más
débil el throughput empeoraría (el RTF actual es 0.05, hay margen ×6 antes del
umbral de 180 s), pero **no está medido** — ver §13.

## 2. Modelo, dtypes, licencia y descarga (R3/R8)

| | Modelo pineado (R3) | Modelo alternativo (solo timestamps) | Fallback wasm |
|---|---|---|---|
| Repo | `onnx-community/whisper-base` | `onnx-community/whisper-base_timestamped` | `onnx-community/whisper-base` |
| Revisión | `27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c` | `608c49e61301901684bc36cac8f74b95ff6b5a8e` | `27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c` |
| Licencia | **apache-2.0** (tarjeta HF; `base_model: openai/whisper-base`) | ⚠️ **sin campo `license` en la tarjeta HF** (base `openai/whisper-base` = MIT) | apache-2.0 |
| `dtype` WebGPU | `model`/`encoder_model` = **fp32**, `decoder_model_merged`/`decoder_model` = **q4** | misma receta | — |
| `dtype` wasm | — | — | `q8` (ficheros `_quantized`) |
| Descarga | encoder 82,468,078 B + decoder q4 123,602,419 B + tokenizer/config ≈ 2,769,562 B = **208,840,059 B** + runtime ORT wasm 26,914,834 B → caché **235,757,136 B** | **+208,961,862 B** (caché → 444,718,998 B) | **+76,894,629 B** (encoder 23,201,314 + decoder 53,693,315 → caché 521,613,627 B) |

- La receta recomendada por el modelo (encoder `fp32` + decoder `q4`) funcionó
  **a la primera**: no hubo que probar `fp16`/`q8` y **no hay errores de dtype
  que documentar**.
- `PerformanceResourceTiming` a `huggingface.co` **no sirve** para bytes
  (sin cabecera `Timing-Allow-Origin` → `transferBytes = 0`; solo
  `cdn.jsdelivr.net` reporta `payloadBytes`, 26,914,834 B del runtime ORT).
  Las cifras autoritativas son el **delta de Cache Storage** y la suma de
  `progress_callback`: 208,840,059 + 26,914,834 = 235,754,893 B, 2,243 B por
  debajo del delta de caché (235,757,136) — exactamente `config.json`, que se
  cachea bajo dos URLs (`/resolve/main/` y `/resolve/<revisión>/`, visibles en
  `downloads.entries`).
- No se commitea ningún peso: `dist/`, `node_modules/`, `fixtures/*.wav`,
  `public/models/` están en el `.gitignore` del spike.

## 3. Corpus (R4)

| Artefacto | Detalle |
|---|---|
| `fixtures/script.txt` | texto **original en inglés, CC0**, 115 frases / **1,431 palabras**, sin números ni siglas (evita que el TTS expanda distinto) |
| `fixtures/sentences.json` | primeras 20 frases con su referencia exacta (versionado) |
| `long-10min.wav` | **576,225 ms** (9 min 36 s, dentro de 540–660 s), 18,439,246 B, 16 kHz mono |
| Generación | `scripts/gen-audio.ps1` con SAPI **`Microsoft Zira Desktop`** (en-US, 16 kHz, `Rate = -2`); duración validada con `ffmpeg-static` |
| Higiene | audio **nunca descargado**, WAVs gitignored, solo se versionan textos |

Sanity-check de audio (por qué el WER largo no es un defecto de grabación): RMS
de las regiones «perdidas» = 0.090 / 0.092 / 0.094 frente a una mediana global
de 0.1018 → **hay voz en todas**; solo 18 pausas de 1 s en todo el fichero.

## 4. Métricas por acción (las 6 del botón, más las fases internas)

| Acción | Carga | Ejecución | RTF | WER (norm / crudo) | UASM final | Nota |
|---|---|---|---|---|---|---|
| Cargar modelo (frío) | **20,663 ms** | — | — | — | 1,487,593,314 B (1,418.68 MiB) | 0 → 235,757,136 B descargados |
| Cargar en caliente (misma sesión) | **976.6 ms** | — | — | — | muestreo final agotado (60 s) | delta caché = 0 |
| Cargar en caliente (tras recarga ×2) | **2,516 ms** / **2,344 ms** | — | — | — | 757,866,475 B / 947,179,759 B | delta caché = 0 en ambos |
| Transcribir 20 frases | — | **6,720 ms** (audio 89,510 ms) | 0.075 | **1.78 %** (5/281) / 2.49 % (7/281) | 955,940,567 B (911.66 MiB) | 20/20 frases OK |
| Transcribir 10 min — fase A (timestamps, pineado) | — | ERROR 4,088 ms (×2: 4,147 ms) | — | — | — | ver §6 |
| Transcribir 10 min — fase B (sin timestamps) | — | **27,470 ms** y **29,311 ms** | **0.0477 / 0.0509** | **14.19 %** (203/1431) / 14.47 % | 1,162,090,845 B (1,108.26 MiB) | texto idéntico en ambas corridas |
| Transcribir 10 min — fase C (timestamps, alternativo) | +1,974 ms (caliente) | 93,179 ms / **98,421 ms** | — | — | — | ver §6 |
| Transcribir 10 min — fase D (diagnóstico) | — | 2,230 / 2,972 / 860 ms | — | 0.9 % / 1.4 % / 3.7 % | — | ver §7 |
| Fallback wasm (sentence-01) | **7,703 ms** | **2,023 ms** | 0.441 | **0.00 %** (0/17) | 1,087,771,036 B (1,037.38 MiB) | no cuenta para el umbral |

Todas las corridas: `outcome = OK` (la fase A falla *dentro* de la corrida y se
registra como `timestampsPinned.ok = false`, no rompe la corrida). 8 resultados
en `window.__WHISPER_RESULTS__`, `<pre>` visible de 74,725 caracteres,
200 líneas de log, marcadores `RUN_DONE: …` presentes.

## 5. Calidad WER (R5.1)

**Método:** tokenización palabra a palabra; normalización = minúsculas +
sustitución de todo lo que no sea letra/dígito por espacio + colapso de
espacios; distancia de Levenshtein con operaciones S/D/I (el WER «crudo»
compara sin normalizar, conservando puntuación).

### 5.1 Veinte frases — **1.78 % (5/281)** normalizado · 2.49 % (7/281) crudo

| Frase | Errores | Referencia → Hipótesis |
|---|---|---|
| 03 | 1/14 | Sailors → Sailor |
| 08 | 2/14 | sat → set · waves → wave |
| 15 | 1/15 | rowed → rode |
| 20 | 1/15 | warned → worn |

→ **Umbral ≤ 10 %: GO, con un orden de magnitud de margen.**

### 5.2 Diez minutos — 14.19 % (203/1431) normalizado · 14.47 % crudo

Desglose exacto (idéntico en las dos corridas, ejecución determinista):

- **S = 8, D = 194, I = 1** → 203 errores; hipótesis = 1,238 palabras vs 1,431 de referencia.
- **12 clusters**: 4 grandes, todos **borrados contiguos** —
  `ref[281..358]` (76), `ref[524..562]` (39), `ref[572..624]` (53),
  `ref[1366..1392]` (26) = **194 palabras**, y 8 sustituciones sueltas:
  sat→set, rowed→wrote, light→lights, warned→worn, seawater→water,
  gulls→gulse, beam→beams, panes→pains.
- **No es un fallo del audio ni del modelo: es el troceado de 10 min** — §7.

> Este WER largo **no es un umbral de R7** (R7 solo fija WER para las 20
> frases), pero condiciona la calidad de subtítulos y se documenta como concern.

## 6. Timestamps por palabra (R5.3 / fila 3 de R7)

### 6.1 Modelo pineado (el exigido por R3): **imposible**

`return_timestamps: "word"` falla siempre con:

```
Model outputs must contain cross attentions to extract timestamps.
This is most likely because the model was not exported with `output_attentions=True`.
```

- Frase (sentence-01): ERROR a los **389 ms**; 10 min: ERROR a los **4,088 / 4,147 ms**.
- Causa verificada **a nivel de bytes**: el ONNX cacheado
  (`decoder_model_merged_q4.onnx`) y los extremos del fichero servidos por HF
  solo contienen tensores `logits` y `present.*` — **no existe
  `cross_attentions.N`** en esta exportación.

### 6.2 Modelo hermano `whisper-base_timestamped` (solo para esta sonda)

Cargado bajo demanda (`loadAltPipeline()`), nunca aporta exec/RTF/WER, y se
`dispose()` al terminar `long-10min`.

| | 1 frase | 10 min |
|---|---|---|
| Ejecución de la sonda | 879 ms | 93,179 ms / **98,421 ms** |
| Palabras con timestamp | 17/17 | **1,445/1,445** |
| Cobertura | **100 %** ✓ | **100 %** ✓ |
| Monótono | **true** ✓ | **false** ✗ — primer retroceso en la palabra 832, **1 retroceso** en total, **máx. 4,300 ms hacia atrás** |
| Inicios distintos | 17/17 | 1,439/1,445 (`duplicateStartShare` reportado 0) |
| Fuera de rango | 0 | 0 |
| Mediana de duración | 220 ms | 300 ms |

Ejemplo de 10 palabras (corrida larga, R5.3):

```
 The   0.26 → 0.52     lighthouse 0.92 → 1.36    at    1.52 → 1.72
 old   0.52 → 0.92     stood      1.36 → 1.52    the   1.72 → 2.04
 edge  2.04 → 2.18     of         2.18 → 2.32    a     2.32 → 2.60
 rocky 2.60 → 3.00
```

**Fila de R7 («monótonos, ≥95 % cobertura»): NO-GO.** Cobertura 100 % ✓, pero
el modelo pineado no los produce y el alternativo **no es monótono** en 10 min
(1 retroceso de 4.3 s, probablemente en frontera de bloque; no se reprodujo el
issue #1358 de timestamps rotos con `chunk_length_s: 30` — aquí solo falla un
arranque de 1,445). Nota de coste: obtener timestamps exige una **segunda
pasada** (+98 s), total 29 + 98 = **127 s < 180 s** (aún dentro del umbral).

## 7. Diagnóstico: ¿de dónde sale el WER del 14 %? (fase D)

Se repitieron **en aislamiento** las 3 regiones que B deja incompletas
(mismo modelo, mismo audio, sin troceado largo):

| Región | Ventana | Ref | Hip | Edits | WER | Diferencias |
|---|---|---|---|---|---|---|
| D1 | 105–150 s | 113 | 113 | 1 | **0.9 %** | warned→worn |
| D2 | 205–260 s | 138 | 138 | 2 | **1.4 %** | tufts→tuffs, gulls→gulse |
| D3 | 545–568 s | 54 | 54 | 2 | **3.7 %** | in→and, language→letter |

**Conclusión:** el mismo audio transcribiéndolo por trozos cortos sale casi
perfecto (0.9–3.7 %), mientras que en la corrida de 10 min esas mismas regiones
se **omiten casi por completo** (194 borrados). La pérdida la produce el
comportamiento de formato largo de `pipeline()` (troceado 30 s / stride 5 s),
**no** el modelo ni el WAV. Tiempos de las repeticiones: 2,230 / 2,972 / 860 ms.

## 8. Memoria — UASM con desglose (R5.4)

`performance.measureUserAgentSpecificMemory()` con COI activo, medición final
tras la inferencia + `breakdown` por URL. El modelo corre en el **hilo
principal** (sin worker), así que el desglose no debe incluir workers.

| Corrida | UASM final | Desglose (B) | Pico JS heap | Muestras |
|---|---|---|---|---|
| Carga fría | **1,487,593,314** (1,418.68 MiB) | Window JS 1,482,988,300 · Shared 4,551,806 · DOM 53,208 | 316.33 MB | 16/16, 0 rechazadas |
| 20 frases | 955,940,567 (911.66 MiB) | JS 951,748,138 · Shared 4,138,925 · DOM 53,504 | 369.83 MB | ok |
| Caliente (recarga 1) | 757,866,475 (722.76 MiB) | JS 753,728,142 · Shared 4,085,213 · DOM 53,120 | 271.61 MB | ok |
| Caliente (recarga 2) | 947,179,759 (903.30 MiB) | JS 945,023,970 · Shared 2,102,917 · DOM 52,872 | 282.94 MB | 1 |
| 10 min (corrida 2) | **1,162,090,845** (1,108.26 MiB) | JS 1,157,774,212 · Shared 4,263,321 · DOM 53,312 | **523.23 MB** | ok |
| wasm | 1,087,771,036 (1,037.38 MiB) | JS 1,083,099,068 · Shared 4,618,464 · DOM 53,504 | 240.39 MB | ok |

- Dos mediciones finales **agotaron el cronómetro de 60 s** de la muestra UASM
  (carga caliente #1 y 10 min #1): quedan registradas como `pageFinalError`
  con la razón exacta; no afectan a las demás filas.
- Todo el pico de JS heap (≤ 523 MB) queda muy por debajo del límite de
  4,192 MB; el grueso del UASM son `ArrayBuffer`/pesos fuera del heap JS.

## 9. Caché frío vs caliente (R5.5)

| Situación | Caché antes → después | Descarga | `pipeline()` |
|---|---|---|---|
| Frío («Limpiar caché» + «Cargar modelo») | 0 → 235,757,136 B | 235,757,136 B | **20,663 ms** |
| Caliente, misma sesión | 235,757,136 → igual | 0 | **976.6 ms** ✓ |
| Caliente, tras recargar la página (×1) | 444,718,998 → igual | 0 | **2,516 ms** ✗ |
| Caliente, tras recargar la página (×2) | 521,613,627 → igual | 0 | **2,344 ms** ✗ |

`env.useBrowserCache = true` en todas. La caché **funciona** (0 bytes
descargados en las 3 segundas cargas), pero **el umbral < 2 s solo se cumple
repitiendo en la misma sesión**: en una visita nueva con caché caliente el
`pipeline()` tarda **2.34–2.52 s**.

**Fila de R7 («Segunda carga en caliente < 2 s»): NO-GO** (2 de 3 mediciones
por encima; la más representativa — página nueva, caché caliente — también).

## 10. Fallback wasm (R5.6)

- `device: "wasm"`, `dtype: q8` sobre `sentence-01.wav`: carga **7,703 ms**
  (descarga +76,894,629 B de ficheros `_quantized`), ejecución **2,023 ms**
  (RTF 0.441), **WER 0 %** (texto idéntico a la referencia), UASM final
  1,087,771,036 B, pestaña viva. No cuenta para el umbral de tiempo.

## 11. Tabla R7 — veredicto incondicional

| Métrica | Umbral GO | Resultado medido | Veredicto |
|---|---|---|---|
| Adaptador WebGPU (`navigator.gpu.requestAdapter()`) | obligatorio | `navigator.gpu` ✓ · adapter `nvidia/blackwell` con `shader-f16` | **GO** |
| 10 min de audio transcritos | < 180 s | **27,470 / 29,311 ms** (RTF 0.0477 / 0.0509) | **GO** |
| Timestamps por palabra (monótonos, ≥95 % cobertura) | obligatorio | pineado: **no los genera** (sin atenciones en el ONNX); alternativo: cobertura 100 % pero **no monótono** (1 retroceso, 4,300 ms) | **NO-GO** |
| WER normalizado (20 frases) | ≤ 10 % | **1.78 %** (crudo 2.49 %) | **GO** |
| Segunda carga en caliente | < 2 s | 977 ms (misma sesión) vs **2,516 / 2,344 ms** (página nueva) | **NO-GO** |
| Pestaña sobrevive | obligatorio | viva tras 8 corridas y varias recargas, sin caídas ni pérdida de `crossOriginIsolated`, todas las corridas posteriores `OK` | **GO** |

**Resultado: NO-GO (4 GO / 2 NO-GO).** Por R7, el modo local **por defecto**
tal como está hoy no puede declararse GO: ni los timestamps monótonos del
modelo pinneado ni la segunda carga < 2 s se cumplen. El tiempo y la calidad
—los dos riesgos históricos— **sí** están resueltos con holgura.

## 12. Plan alternativo (exigido por R7 ante NO-GO)

1. **Timestamps (fila que falla):**
   - Usar `onnx-community/whisper-base_timestamped` como fuente (única
     exportación ONNX con `cross_attentions.N` verificada) **y pasar un
     post-proceso monotónico**: recortar cada arranque al máximo con el
     anterior (`start = max(start, prevStart)`) y fusionar solapes en frontera
     de bloque. Con 1 retroceso en 1,445 palabras, el parche es trivial y
     dejaría la fila en GO; hay que **resolver antes la licencia** (la tarjeta
     no declara `license`; alternativa: verificar el export de la comunidad
     `openai/whisper-base` MIT o re-exportar el pineado con
     `output_attentions=true` — decisión de arquitectura, no de este spike).
   - Coste: +98 s de segunda pasada → total 127 s, aún < 180 s.
2. **Segunda carga < 2 s (fila que falla):** en la propia app, mantener la
   instancia de `pipeline()` viva en un singleton a nivel de módulo (como
   hace este spike entre corridas: **977 ms**) y/o precargar en idle tras el
   primer render. Si aun así se necesita < 2 s en visita nueva, bajar a
   `whisper-tiny` (no medido aquí: los datos disponibles solo justifican la
   recomendación de arquitectura, no una cifra).
3. **WER del 10 min (concern, no umbral):** las regiones se transcriben al
   0.9–3.7 % por separado (§7), así que la solución correcta es **segmentar
   por silencio/VAD antes de `pipeline()`** (o reducir `stride_length_s`) en
   vez de cambiar de modelo.

## 13. Concerns y limitaciones

- **Adaptador `nvidia/blackwell`, no la iGPU AMD del brief** — los números son
  de esta GPU; el RTF 0.05 da margen, pero en GPU media habría que re-medir.
- **`whisper-base_timestamped` sin licencia declarada** en su tarjeta HF
  (base MIT) — bloqueante legal si se adopta.
- **UASM:** dos mediciones finales agotaron el cronómetro de 60 s; el resto
  (6/8) tienen desglose completo.
- **Caché caliente por encima de 2 s en visita nueva** (2.34–2.52 s).
- El log de la página refleja un reinicio del servidor Vite
  (`[vite] server connection lost…`) durante la sesión; las corridas
  posteriores siguieron siendo OK.
- El issue upstream #1358 (timestamps rotos con `chunk_length_s: 30`) **no se
  reprodujo**: solo 1 arranque fuera de orden en 1,445 palabras.

## 14. Higiene y reproducción (R8)

- `bun run typecheck` → **0 errores**; `bun run build` → OK.
- Diff **limitado a `spikes/whisper-webgpu/`**; cero cambios en `apps/*`,
  raíz, `biome.json`, `.moon/`, `bunfig.toml` ni en el spike de Task 6; sin
  `moon ci`.
- **No se commitean** pesos ni audio (solo `script.txt` + `sentences.json`).
- Reproducción: `cd spikes\whisper-webgpu && bun install && bun run fixtures &&
  bun run dev` → http://localhost:5176 (los 6 botones, en el orden del
  `README.md`); resultados en `window.__WHISPER_RESULTS__`, `__WHISPER_INFO__`,
  `#markers`, `<pre id="results">` y `#log`, persistidos en `localStorage`
  (`monetizaclip.whisper-spike.v1`).
- Tamaño descargado, licencia y revisión pinneada: §2 (R8).
