# RESULT — Task 7: Spike Whisper WebGPU (Go/No-Go)

> **VEREDICTO GLOBAL (Ronda 3, F5): GO para el MVP.**
>
> **Bloque MVP — todos deben pasar; todos pasan** (medidos en el adaptador de
> referencia `nvidia/blackwell`; §11 y la Ronda 3 al final):
>
> | Requisito MVP | Estado medido |
> |---|---|
> | Adaptador WebGPU presente | ✓ `navigator.gpu` + adapter + `requestDevice()` real en las 3 preferencias (23–34 ms) |
> | 10 min < 180 s en el adaptador de referencia medido | ✓ 27.5–43.0 s (RTF 0.0477–0.0747) |
> | Timestamps utilizables para cortes (nivel segmento, monótonos, fronteras) | ✓ 112 segmentos, **0 retrocesos**, cobertura por unión **98.5 %**, 93.7 % de fronteras a ±0.5 s de un silencio real |
> | WER largo aceptable con el camino de producción (`return_timestamps: true`) | ✓ **1.89 %** (27/1431) ≤ 10 % |
> | Sin crash de pestaña | ✓ 16 corridas `OK` + 1 `ERROR` controlado (altgpu sin GPU seleccionable, por diseño) |
> | Caché funcionando (0 bytes re-descargados) | ✓ §9: 0 B transferidos en las recargas con caché caliente |
>
> **Bloque diferido — no bloquea el MVP (owner / trigger):**
>
> | Diferido | Owner | Trigger |
> |---|---|---|
> | Timestamps por palabra (licencia permissiva o re-export) | controller (producto) | si la UI exige nivel palabra → ruta de menor coste §12 (alineador sobre segmentos ya validados, o re-export con `output_attentions`) |
> | Verificación de la clase GPU en máquinas no-NVIDIA (gate **RTF ≤ 0.31**) | controller (validación) | banco de pruebas con iGPU real; hasta entonces el GO es sobre la GPU medida (el hardware floor ×4 de §11 da margen) |
> | Carga nueva < 2 s (nice-to-have; umbral ratificado **< 3 s** = R12, intacto) | controller (perf) | si el producto exige < 2 s; medido en la Ronda 3: **1.96–2.12 s** con flags por defecto y **1.64–1.72 s** con `allowRemoteModels=false` (0 peticiones a HF) |
> | Chunking manual (30 s / solape 5 s) | spike/dev | **ninguno — es diagnóstico**: la producción usa `return_timestamps: true` (WER 1.89 %); el manual quedó en 5.66 % por 5 solapes miss (explicado en la Ronda 3, F3) |
>
> La **Ronda 3** cierra los hallazgos F2–F5 (bases de WER, cobertura por
> unión, fix del merge + autochequeo, sonda F4 sin modelos remotos) y corrige
> dos menores (`Rate = 0`, riesgo de 8 GB); ver «Ronda 3» al final. Las
> corridas de la Ronda 1 son §§1–10 y §14; la Ronda 2 (F1–F5) está después.
> `ARCHITECTURE.md:110` dice «IndexedDB» y el dato real es la **Cache API** —
> corrección de doc pendiente (no se edita ese fichero aquí).
>
> *(Ronda 1: NO-GO con 4 GO / 2 NO-GO — timestamps monótonos y carga < 2 s;
> el primer criterio se resuelve con timestamps de nivel segmento (Ronda 2) y
> el segundo queda como diferido con su trigger. Ronda 2: «GO con dos
> condiciones» — la Ronda 3 las convierte en el bloque diferido de arriba:
> el veredicto ya no lleva condiciones en la frase.)*

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
| Generación | `scripts/gen-audio.ps1` con SAPI **`Microsoft Zira Desktop`** (en-US, 16 kHz, `Rate = 0` — valor real de la línea 45 del script; la Ronda 3 corrige una errata anterior que decía `-2`); duración validada con `ffmpeg-static` |
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

**Bases de WER (corrección F2, Ronda 3):** la Ronda 2 presentó en la misma
tabla dos números con bases distintos. A partir de la Ronda 3 se separan:

- **`werRef`** — WER del transcript producido **contra la referencia** del
  guion (1,431 palabras en 10 min; 281 en las 20 frases). **Es la única
  columna del veredicto:** 1.89 % con timestamps de segmento, 5.66 % con
  chunking manual, 14.19 % sin timestamps (Ronda 1).
- **Diagnóstico transcript-vs-transcript** (la Ronda 2 lo etiquetó «WER vs
  corrida sin ts»: **16.96 %**, 210 errs sobre los 1,238 palabras del
  transcript sin timestamps) — compara **dos transcripts del mismo audio**
  (con timestamps vs sin timestamps). No mide calidad contra la referencia,
  **no entra en la columna `werRef` ni en el veredicto**; en
  `__WHISPER_RESULTS__` el campo se renombró
  `segmentReport.diagWerTranscriptVsTranscript` y así se etiqueta en el log.

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

> **Ronda 3 (F2):** la fila MVP de cortes se sostiene con los timestamps de
> **nivel segmento** (`return_timestamps: true`, Ronda 2), no por palabra.
> Su cobertura se recalcó como **unión de intervalos** (98.5 %) y el ~1.5 %
> restante está localizado tramo a tramo (8 huecos, todos en silencio medido)
> — ver «Ronda 3 — F2» al final. La fila por palabra sigue en NO-GO; sin
> cambios.

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

## 11. Tabla final (Ronda 2, F5) — MVP vs nice-to-have

### Requerido por el MVP

| Métrica | Umbral GO | Resultado medido (Ronda 1 + 2) | Veredicto |
|---|---|---|---|
| WebGPU presente | obligatorio | `navigator.gpu` ✓ · adapter `nvidia/blackwell` (`shader-f16`, `maxBufferSize` 2 GiB) · `requestDevice()` real OK en las 3 preferencias (23–34 ms) | **GO** |
| 10 min < 180 s en la clase GPU objetivo | < 180 s | sin timestamps **27,470 ms** (RTF 0.0477) · con timestamps de segmento **42,368 ms** (RTF 0.0735) · chunking manual **34,636 ms** (RTF 0.060) | **GO** (ver hardware floor) |
| Timestamps utilizables para cortes | obligatorio | 112 segmentos en 10 min, **monótonos** (0 retrocesos, 0 rangos inválidos), cobertura por **unión** 98.5 % (567.6 s de 576.2 s; Σ = unión, sin solapes — Ronda 3), duración mediana 4.93 s / p95 7.6 s; fronteras a ±0.5 s de un silencio real **93.7 %** y ±1.0 s **97.3 %** (recall 75.4 / 79.0 %) | **GO** |
| Sin crash de pestaña | obligatorio | 14 corridas `OK` + 1 `ERROR` controlado (altgpu sin GPU seleccionable, por diseño); pestaña viva, `crossOriginIsolated` intacto, consola sin errores JS | **GO** |
| WER largo aceptable | ≤ 10 % | **1.89 %** (27/1431) con timestamps de segmento · **5.66 %** (81/1431) chunking manual (diagnóstico) · 14.19 % sin timestamps (Ronda 1) | **GO** |
| Caché funcionando (0 bytes re-descargados) | obligatorio | §9: 0 B transferidos en las 3 recargas con caché caliente (235 MB → 0 descarga); caveat: `transferSize` cruzado es 0 sin `Timing-Allow-Origin`, el dato crudo está en §9 | **GO** |

### Nice-to-have (no bloquean el MVP)

| Métrica | Umbral | Resultado | Veredicto |
|---|---|---|---|
| Timestamps por palabra | deseable | modelo pineado sin `cross_attentions` en el ONNX; `_timestamped` sin licencia declarada → imposible con licencia permissiva. Ruta de menor coste: §12 | **NO-GO** |
| Carga nueva < 2 s | deseable | **2,344 / 2,516 ms** (Ronda 1) · **2,834 ms** instrumentada (F4, desglose abajo); 977 ms reutilizando instancia en la misma sesión | **NO-GO** |

**Veredicto: GO para el MVP (incondicional — Ronda 3, F5).** Las 6 filas de
arriba pasan; ninguna condición se cuelga de la frase de veredicto. El alcance
y lo diferido viven en el bloque diferido de la cabecera (con owner y trigger):

- **Alcance de la medición (no es una condición del veredicto):** todos los
  números son de `nvidia/blackwell`. El peor RTF del MVP es 0.0747 (10 min con
  timestamps de segmento, Ronda 3); con **factor de seguridad ×4** el techo es
  RTF 0.30 < 0.31 (= 180 s / 576 s), así que el GO cubre GPUs al menos ~4×
  más lentas que la medida. **Diferido (owner: controller / validación;
  trigger: banco con iGPU real):** verificar la clase GPU no-NVIDIA con ese
  gate RTF ≤ 0.31 — `requestAdapter()` sin opciones, con `low-power` y con
  `high-performance` devuelve en los tres casos la **misma** `nvidia/blackwell`
  (1 GPU distinta en 3 preferencias; ninguna no-NVIDIA; no existe API de
  selección — chrome://gpu no es scriptable), por lo que la fila «10 min en
  GPU integrada» queda **unproven** con la corrida `long-10min-altgpu`
  (`ERROR` controlado) como evidencia machine-readable.

## 12. Ruta de menor coste (F5) — timestamps por palabra y carga < 2 s

1. **Timestamps por palabra (nice-to-have):** con licencia permissiva no hay
   export ONNX con `cross_attentions` (§6.1), así que hay dos caminos:
   - **(recomendado) Segmento + alineación:** usar los timestamps de segmento
     ya medidos y validados (F2, fila MVP en GO) y, solo si la UI necesita
     palabras, alinear el texto de cada segmento recortado con un alineador
     forzado ligero sobre el WAV de la ventana (p. ej. MFA/whisperX-style).
     **Coste:** 0 modelos nuevos; ~1 pasada extra por clip recortado (no sobre
     los 10 min); revisar licencia del alineador.
   - **Re-export del modelo pineado con `output_attentions=True`:** **coste:**
     trabajo de export, ONNX más grande (atenciones del decodificador) y
     memoria en navegador durante el decodificado (por eso el export actual
     las omite). Solo justifica si el alineador se descarta.
   - **Prohibido:** interpolación proporcional de palabras entre fronteras de
     segmento — inventa tiempos en silencios y en huecos; no es defendible.
2. **Carga nueva < 2 s (nice-to-have, umbral intacto):** el desglose F4 muestra
   que de 2.83 s instrumentados, **~1.24 s son sondas de metadata
   `Range: bytes=0-0` a huggingface.co** y **~1.47 s la creación de sesiones
   ORT + pipelines WebGPU** (solo 25 ms son `requestDevice`). Palancas para el
   controller: servir `config`/`tokenizer`/ONNX sin sondeo remoto tras la
   primera visita (Service Worker o `local_files_only` con precarga), mantener
   el `pipeline()` en singleton (**977 ms** en la misma sesión) y precargar en
   idle tras el primer render.
3. **WER largo:** resuelto en la Ronda 2 (F2 1.89 % / F3 5.66 %). Si se
   necesita el camino **sin** timestamps, el chunking manual por ventanas de
   30 s / solape 5 s ya elimina las delecciones (D194 → D0); queda pulir el
   merge (5 solapes miss → +62 inserciones, § Ronda 2).

## 13. Concerns y limitaciones

- **Adaptador `nvidia/blackwell`, no la iGPU del brief** — todos los números
  (Ronda 1 y 2) son de esta GPU; el hardware floor de §11 da margen ×4, pero
  la clase GPU mainstream **queda sin probar** (F1 no pudo seleccionar otra:
  las 3 preferencias devuelven la misma GPU).
- **`whisper-base_timestamped` sin licencia declarada** en su tarjeta HF
  (base MIT) — bloqueante legal si se adopta; por eso los timestamps por
  palabra siguen en NO-GO (§12).
- **UASM:** dos mediciones finales de la Ronda 1 agotaron el cronómetro de
  60 s; en la Ronda 2 varias corridas tardaron ~30–60 s en la muestra final
  (el `exec` real está en `execMs`, no en `wallMs`).
- **Carga en caliente / visita nueva — estado final (Ronda 3, sin lectura
  «apple-to-apple»):** misma sesión (caliente): **946–1,111 ms**; visita
  nueva con flags por defecto: **1.96–2.12 s** (2.34–2.52 s en la Ronda 1;
  2.83 s instrumentada en la F4 de la Ronda 2); visita nueva con
  `allowRemoteModels=false` primero: **1.64–1.72 s con 0 peticiones a HF** —
  **la única configuración que cumple el nice-to-have `< 2 s`** (el umbral
  ratificado `< 3 s` = R12 se cumple en todas). **Caveat honesto:** solo
  existe **una** medición limpia de visita nueva del camino instrumentado y
  las comparaciones **no son apples-to-apples** — el 2.83 s de la Ronda 2
  tenía 6 ficheros sin servir desde caché más overhead de hooks, y los
  números de la Ronda 3 salen de un estado de caché más caliente y con una
  sonda distinta; **no se presenta como una mejora neta**. Para la
  validación final del controller se recomienda un protocolo uniforme: perfil
  fresco, caché borrada, hooks idénticos y 3 repeticiones por configuración.
- **Instrumentación con overhead:** el desglose F4 (2,834 ms) corre con hooks
  sobre Cache API/fetch/estáticas y queda por encima de los 2,344/2,516 ms
  sin instrumentar; usarlo para **proporciones**, no como nuevo baseline.
- **`cacheReadSumMs` es solo el `match()` de Cache API** (13 ms/33 lecturas):
  el streaming del body (199 MiB) ocurre después, dentro de las ventanas de
  tokenizer/modelo, y no se atribuye a esa cifra.
- **Corridas únicas por métrica nueva** (F2, F3, F4): sin repeticiones; los
  deltas son grandes (D194 → D0; 14.19 % → 1.89 %) pero conviene repetir en
  la validación del controller.
- **`ARCHITECTURE.md:110` documenta «IndexedDB»** para la caché del modelo y
  el mecanismo real es la **Cache API** (`transformers-cache`); corrección de
  documentación pendiente fuera de este spike (no se edita ese fichero aquí).
- El log de la página refleja un reinicio del servidor Vite
  (`[vite] server connection lost…`) durante la sesión de la Ronda 1; las
  corridas posteriores siguieron siendo OK.
- El issue upstream #1358 (timestamps rotos con `chunk_length_s: 30`) **no se
  reprodujo**: 0 retrocesos en los 112 segmentos de los 10 min (y solo 1
  arranque fuera de orden en 1,445 palabras en la Ronda 1).
- **Riesgo en máquinas de 8 GB (sin medir — nota Ronda 3):** el pico UASM
  medido es **1.16 GB** en una caja de 32 GB (corrida 10 min, §8). En un
  equipo de 8 GB con iGPU compartida se espera presión de memoria: el SO
  puede recurrir a swap (thrashing: carga/inferencia muy por encima de los
  tiempos medidos) y Chrome puede matar la pestaña («Aw, snap») si el
  conjunto de trabajo supera su límite. **No existen números medidos para
  8 GB — riesgo sin cuantificar, no inventado.** Mitigaciones ya disponibles
  en el spike: fallback **wasm** (§10: 7,703 ms de carga, RTF 0.441, WER 0 %),
  modelo **`whisper-tiny`** (menor memoria; no medido en este spike) y
  **opt-in a la nube** (fuerza del alcance local-first). Trigger: exigir un
  banco de 8 GB antes de prometer esa clase (owner: controller/validación).

## 14. Higiene y reproducción (R8)

- `bun run typecheck` → **0 errores**; `bun run build` → OK.
- Diff **limitado a `spikes/whisper-webgpu/`**; cero cambios en `apps/*`,
  raíz, `biome.json`, `.moon/`, `bunfig.toml` ni en el spike de Task 6; sin
  `moon ci`.
- **No se commitean** pesos ni audio (solo `script.txt` + `sentences.json`).
- Reproducción: `cd spikes\whisper-webgpu && bun install && bun run fixtures &&
  bun run dev` → http://localhost:5176 (los **11 botones** — 10 de la Ronda 2
  más «Carga sin remoto (F4)» de la Ronda 3, en el orden del `README.md`;
  el autochequeo `selfcheck` corre solo al cargar la página), resultados en
  `window.__WHISPER_RESULTS__`, `__WHISPER_INFO__`,
  `#markers`, `<pre id="results">` y `#log`, persistidos en `localStorage`
  (`monetizaclip.whisper-spike.v1`).
- Tamaño descargado, licencia y revisión pinneada: §2 (R8).

---

# Ronda 2 — F1–F5 (extensión del spike)

Misma rama y mismo directorio (`spikes/whisper-webgpu/`), sin dependencias
nuevas, sin pesos ni WAV commiteados y con `bun run typecheck` → 0. Cuatro
botones nuevos (F1–F3) más la corrida alternativa; todos los resultados nuevos
viven en `window.__WHISPER_RESULTS__` (campos `adapters`, `segmentReport`,
`segmentSentences`, `manualChunk`, `loadBreakdown`, `forcedAdapter`) y en
`localStorage`. Orden ejecutado: sonda de adaptadores → carga en caliente
instrumentada (F4) → timestamps de segmento (F2) → chunking manual (F3) →
adaptador alternativo (F1) → desglose.

## F1 — GPU real, adaptadores y hardware floor

`requestAdapter()` enumerado con sin opciones (`default`), `low-power` y
`high-performance`; para cada uno se registró `adapter.info` + límites y se
ejecutó un `requestDevice()` real (el mismo camino que usa ORT), destruyendo
el device después:

| Preferencia | Adapter | `requestDevice()` | Misma GPU que default |
|---|---|---|---|
| (sin opciones) | `nvidia/blackwell` | OK **34.4 ms** | — |
| `low-power` | `nvidia/blackwell` | OK **22.5 ms** | sí |
| `high-performance` | `nvidia/blackwell` | OK **24.4 ms** | sí |

- `features`:21 incl. `shader-f16`, `timestamp-query`, `texture-compression-bc`;
  `maxBufferSize` 2,147,483,648 B (2 GiB), `maxStorageBufferBindingSize`
  2,147,483,644 B, `maxComputeWorkgroupStorageSize` 32,768 B.
- **Todas las preferencias devuelven la MISMA GPU NVIDIA** → `distinctGpus: 1`,
  `nonNvidiaPrefs: []`, `forcedPref: null`. No hay API de selección de GPU
  (chrome://gpu no es scriptable), solo el `powerPreference`.
- **La clase GPU mainstream queda SIN PROBAR («unproven»)**: no existe
  adaptador no-NVIDIA que reutilizar en esta máquina.
- Corrida «10 min en adaptador alternativo»: resultado `ERROR` con mensaje
  `"la sonda no encontró ninguna GPU no-NVIDIA seleccionable (todas las
  preferencias devuelven la misma GPU)"` — evidencia machine-readable.
- **Hardware floor:** peor RTF del MVP = 0.0735 (10 min con timestamps);
  techo con factor de seguridad ×4 = RTF 0.29 < 0.31 (180 s / 576.2 s).
  **GO aplica a GPUs al menos ~4× más lentas que `nvidia/blackwell`**; por
  debajo, RTF > 0.3 y los 10 min superan 180 s.

## F2 — Timestamps de nivel segmento (`return_timestamps: true`)

**¿Funciona? SÍ**, en las 3 frases y en los 10 min, con el modelo pineado
(`onnx-community/whisper-base@27a07b4b…`, sin tocar `_timestamped`):

| Corrida | exec | Segmentos | Cobertura (Σ, Ronda 2) | Monótono | Invál./fuera de rango | Duración mediana / p95 | WER vs ref | DIAG vs corrida sin ts (no es vs ref) |
|---|---|---|---|---|---|---|---|---|
| sentence-01 (4.59 s) | 747 ms | 1 | 87.2 % | ✓ | 0 / 0 | 4,000 / 4,000 ms | **0.00 %** (0/17) | — |
| sentence-03 (4.56 s) | 365 ms | 1 | 87.8 % | ✓ | 0 / 0 | 4,000 / 4,000 ms | 7.14 % (1/14) | — |
| sentence-08 (4.04 s) | 377 ms | 1 | 99.0 % | ✓ | 0 / 0 | 4,000 / 4,000 ms | 14.29 % (2/14) | — |
| **10 min (576.2 s)** | **42,368 ms** (RTF 0.0735) | **112** | **98.5 %** (567.6 s) | **✓ 0 retrocesos** | 0 / 0 | **4,930 / 7,600 ms** (min 80, máx 9,920) | **1.89 %** (27/1431) | 16.96 % (210 errs) — **diagnóstico, no entra en el veredicto** (F2, Ronda 3) |

- Fronteras de segmento vs silencios reales (frames 100 ms, umbral
  `max(0.005, 0.25×mediana RMS)`, tramos ≥ 400 ms): **138 tramos de silencio,
  111 fronteras interiores** → **93.7 % a ±0.5 s**, **97.3 % a ±1.0 s**;
  recall de silencios con frontera: 75.4 % (±0.5 s) / 79.0 % (±1.0 s).
- Muestra de 10 segmentos (los primeros; cada uno coincide con una frase del
  guion, contiguos y sin solapes):

| # | start–end (s) | Texto |
|---|---|---|
| 1 | 0.00–4.48 | The old lighthouse stood at the edge of a rocky point… |
| 2 | 5.60–11.52 | For as long as anyone could remember, its light had swept… |
| 3 | 12.64–17.04 | Sailor said that the beam was brighter than any other light… |
| 4 | 18.08–23.44 | They were grateful for it, because the rocks below… |
| 5 | 24.64–29.68 | The keeper lived alone in a small stone house… |
| 6 | 29.68–35.28 | Each evening he climbed the narrow stairs… |
| 7 | 35.28–40.40 | He filled the lamp with oil and checked the clockwork… |
| 8 | 40.40–45.52 | Then he set by the window and listened to the waves… |
| 9 | 45.52–50.72 | His only companion was a grey cat… |
| 10 | 50.72–55.96 | The cat never hunted the birds… |

- **Juicio de uso para cortes (±0.5–1 s):** SÍ utilizable — 1 de cada 10
  fronteras cae a >0.5 s de un silencio real y solo 1 de cada 38 a >1 s; las
  fronteras siguen fronteras de frase. **Estrategia de snap:** recortar en los
  bordes de segmento (frase completa) y, si el corte fino necesita palabra,
  alinear solo el segmento recortado con un alineador forzado (§12).
  **La interpolación proporcional entre timestamps NO es aceptable**: los
  segmentos tienen huecos reales (p. ej. 4.48→5.60 s) y repartir proporcional
  colocaría palabras dentro de los silencios.
- Nota: el WER con timestamps (1.89 %) es **mucho mejor** que el mismo audio
  sin timestamps (14.19 %): el camino con `return_timestamps` no reproduce las
  delecciones en bloque de la corrida sin timestamps (D194 → D27 en total).

## F3 — Chunking manual (30 s / solape 5 s, fusión por solape)

23 ventanas (la última alineada al final: 546.23–576.23 s), transcripción
independiente **con** timestamps de segmento (F2 OK → offsets absolutos) y
fusión de texto normalizado por solape exacto (k ≥ 4) o fuzzy (≤15 % de
mismatch, k ≤ 60):

| Métrica | Resultado |
|---|---|
| Ventanas / exec total / wall | 23 · **34,636 ms** · 34,796 ms (**< 180 s**) |
| Solapes | 11 exactos · 6 fuzzy · **5 miss** (sin solape detectable) |
| WER vs 1,431 palabras | **5.66 %** (81 errs; crudo 23.48 % por puntuación) |
| Operaciones | **S19 / D0 / I62** vs baseline **S8 / D194 / I1** → **ΔD −194** |
| Exec por ventana | 1,396–1,648 ms (media ~1,506 ms) |

- **Las delecciones del 14.19 % desaparecen por completo (D194 → D0)**; el
  residuo son inserciones (+61): los 5 solapes «miss» duplican texto cuando
  las dos ventanas transcriben distinto la misma región (o no comparten
  palabras porque el solape cae en silencio). Con el merge afinado, el techo
  teórico es ≈ (19+1)/1431 ≈ **1.4 %**.
- **Si la pérdida persistiera se mantendría NO-GO de calidad — pero no
  persiste**: 5.66 % ≤ 10 % (y el camino con timestamps está en 1.89 %).

> **Corrección F3 (Ronda 3):** la fórmula de fusión de esta corrida era
> `acc.slice(0, acc.length - overlap).concat(winTokens)` — sustituida por la
> canónica `acc.concat(winTokens.slice(overlap))` (ver «Ronda 3 — F3»). El
> autochequeo `findOverlap`+merge pasa (corrida `selfcheck` en
> `__WHISPER_RESULTS__`), pero **el WER no cambió: sigue 5.66 % / S19 D0
> I62**, porque los 62 tokens de más no salen de esa fórmula — salen de los
> **5 solapes miss** (desglose exacto en la Ronda 3). Los números de esta
> tabla se mantienen como evidencia de la Ronda 2; la explicación está en la
> Ronda 3.

## F4 — Desglose de la carga en caliente (2.34–2.52 s → 2.83 s instrumentada)

`performance.mark/measure` (`spike:load:start/end`, `spike:load:config`,
`spike:load:tokenizer`, `spike:load:model`, `spike:load:total`) + hooks sobre
`Cache.prototype.match`, `env.fetch` y `globalThis.fetch`, estáticas
`AutoConfig`/`AutoTokenizer`/`AutoModelForSpeechSeq2Seq.from_pretrained`,
`InferenceSession.create`, `WebAssembly.instantiate*` y
`adapter.requestDevice` (todo se restaura al terminar). **El umbral `< 2 s` no
se tocó.**

| Componente | ms | % de 2,834 ms |
|---|---|---|
| **Sondas de metadata `Range: bytes=0-0` (red)** | **1,240.3** | 43.8 % |
| **Sesiones ORT (2) = grafo + pipelines WebGPU** | **1,465.7** | 51.7 % |
| — de las cuales `requestDevice()` | 25.5 | 0.9 % |
| — compilación/instantiación wasm (1) | 24.8 | 0.9 % |
| Modelo «other» (tensor alloc, lectura de bodies) | 507.2 | 17.9 % |
| Red (3 fetch no-metadata) | 229.0 | 8.1 % |
| Parseo tokenizer | 98.0 | 3.5 % |
| Config | 0.04 | ~0 % |
| Lookup de Cache API (33 match, 199 MiB de bodies) | 13.5 | 0.5 % |
| Residuo (puede ser negativo: solapes) | −719.1 | — |

- `tokenizerWallMs` (98) y `modelWallMs` (1,981.7) se solapan vía
  `Promise.all`; las lecturas de caché se atribuyen a la ventana en la que
  cayeron; el residuo negativo indica tiempo contado dos veces (fetch/sondas
  dentro de las ventanas del modelo) — números crudos, sin retocar.
- **Lectura honesta para producción:** el modelo **se carga una vez por
  sesión** (977 ms reutilizando la instancia; 2.34–2.83 s en visita nueva) y
  **no se recarga por cada transcripción** (las corridas posteriores solo
  ejecutan inferencia). Casi la mitad de la carga nueva son RTTs de metadata
  a huggingface.co y la otra mitad la creación de sesiones ORT/WebGPU —
  palancas de optimización en §12. Quien decide el `< 2 s` es el controller.

## F5 — Veredicto

En la cabecera (bloque MVP + bloque diferido, F5 de la Ronda 3) y en §11.

---

# Ronda 3 — cierre de hallazgos F2–F5 (merge, cobertura, veredicto, sondas HF)

Misma rama y mismo directorio (`spikes/whisper-webgpu/`), sin dependencias
nuevas, sin pesos ni WAV commiteados. `bun run typecheck` → **0** y
`bun run build` → **0** (el servidor sirve `dist/` vía `vite preview`, por
eso hace falta reconstruir). Un único commit:
`spike(whisper): merge del chunker, cobertura real y veredicto incondicional (task 7)`.

## F3 (CRITICAL) — fix del merge + autochequeo; por qué las inserciones no colapsaron

**Fix aplicado** (`main.ts`): la fusión pasó de
`acc.slice(0, acc.length - overlap).concat(winTokens)` a
`acc = overlap > 0 ? acc.concat(winTokens.slice(overlap)) : acc.concat(winTokens)`;
`findOverlap` acepta ahora solape **exacto con k ≥ 2** (el fuzzy sigue en
k ≥ 4, ≤ 15 % de mismatch).

> **Riesgo k ≥ 2 (documentado):** un solape exacto **coincidental** de 2
> tokens («of the», «in the») podría sobrededuplicar y borrar palabras
> legítimas. Mitigación: la búsqueda es de **k más largo a más corto** y el
> fuzzy exige k ≥ 4; evidencia empírica: S19/D0/I62 **idénticos** antes/después
> del cambio; cota: como mucho unos pocos tokens por ventana y solo con
> matches exactos coincidentes.

**Autochequeo (corrida `selfcheck`, se ejecuta en cada carga de página, sin
inferencia, publicada en `window.__WHISPER_RESULTS__`):**
`acc = "a b c d e"`, `win = "d e f g"` → `findOverlap` k=2 exacto →
**`"a b c d e f g"` — PASS**; caso sin solape (`"one two three"` +
`"unrelated words"` → concatenación entera) — **PASS**. Verificable sin una
corrida en el navegador.

**Re-corrida de los 10 min con chunking manual (23 ventanas, 30 s / solape 5 s):**

| Métrica | Ronda 2 (fórmula vieja) | Ronda 3 (fix) |
|---|---|---|
| WER vs 1,431 palabras | 5.66 % (81 errs) | **5.66 % (81 errs) — sin cambios** |
| Operaciones | S19 / D0 / I62 | **S19 / D0 / I62** (baseline S8/D194/I1, ΔD −194) |
| Ventanas / exec / wall | 23 · 34,636 ms · 34,796 ms | 23 · **34,455 ms** · 34,630 ms (1,337–1,643 ms/ventana) |
| Solapes | 11 exactos · 6 fuzzy · 5 miss | idéntico (mismas ventanas miss: 1, 5, 7, 17, 21) |
| Texto fusionado | — | **distinto** (ej. pos 1,152: «letters» → «letter»); mismos S/D/I |

**Desglose exacto de por qué no colapsó el I62:** Σ `wordsIn` **1,713** −
Σ `overlapWords` **220** = hipótesis **1,493**; referencia 1,431 → excedente
**62 = I62** (cuenta cierra exacta). Los **5 solapes miss** re-transcriben la
región compartida de 5 s por completo — las dos transcripciones no comparten
tokens (`Heeper lived alone…` vs `The keeper lived alone…`; colas alucinadas
`Eat.`, `from his.`) — y **con k=0 las dos fórmulas appendean la ventana
entera**: 5 × ~12,4 palabras (5 s × 2,48 palabras/s) ≈ **62**. La fórmula
nueva y la vieja son **matemáticamente equivalentes en solapes exactos**
(`acc[:-k] + win == acc + win[k:]` cuando sufijo = prefijo) y de **misma
longitud** en los fuzzy (la diferencia observada es de 1 token y no cambia
S/D/I); el excedente no puede salir de ahí.

→ **Corrección de la hipótesis del hallazgo:** el I62 no lo infla la fórmula
de fusión sino los **5 misses** (sin alineación no hay dedup posible cuando
las ventanas discrepan). Palanca siguiente propuesta (no implementada):
fallback «infix fuzzy» acotado en misses — buscar el prefijo de `win` dentro
de los últimos ~25 tokens de `acc` con k ≥ 6 y ≤ 15 % mismatch y descartar
`win[0..j+k)`. El camino de producción no depende de esto: usa
`return_timestamps: true` (**WER 1.89 %**, fila MVP en GO). Los
`windows[i].segments` siguen siendo **por ventana** (offsets absolutos): no
se concatenan en una lista global (evita duplicados en fronteras) y **no
entran en el WER del merge** — documentado en el código (F3, Ronda 3).

## F2 — bases de WER separadas y cobertura por unión

- **`werRef` (la columna del veredicto):** 1.89 % (27/1431) — sin cambios.
- **`diagWerTranscriptVsTranscript` (renombrado):** el 16.96 % (210 errs)
  era transcript-vs-transcript (mismo audio, con vs sin timestamps); ahora
  va etiquetado como **DIAG** en el log y en el JSON y **no se muestra junto
  a `werRef`** en ninguna columna de veredicto (§5 actualizado).
- **Cobertura = unión de intervalos / duración:** re-corrida de los 10 min —
  112 segmentos, **Σ 567,600 ms = unión 567,600 ms** → **98.50 %** de
  576,225 ms. Los segmentos **no se solapan**, así que el 98.5 % de la
  Ronda 2 se confirma como cobertura real; el código ya calcula por unión y
  conserva `sumCoveredMs` como histórico.
- **Localización del ~1.5 %:** **8 huecos ≥ 100 ms = 8,625 ms (1.50 %)**,
  **los 8 dentro de silencios medidos** del WAV (pausas entre frases del
  TTS): 4.48–5.60, 11.52–12.64, 17.04–18.08, 23.44–24.64, 70.16–71.20,
  75.20–76.24, 80.00–81.12 y 575.28–576.23 s. El más cercano a una frontera
  de chunk de 30 s está a **5.04 s** → **no es un corte de chunk**; el audio
  es TTS puro, no hay música. Nada de habla perdida.
- **¿Puede caer un corte en un hueco?** Sí, pero un hueco es **silencio sin
  habla**: recortar ahí no pierde palabras. El validador de cortes debe:
  (1) preferir fronteras de segmento (snap ya documentado en F2); (2) si el
  corte pedido cae dentro de un hueco, **no rechazarlo** — clamp al borde de
  segmento más cercano (aquí ≤ 1.2 s) y marcar `cutInsideSilence` para la UI;
  (3) nunca interpolar dentro del hueco. El dato por corrida sale de
  `segmentReport.uncovered[]` (`startS/endS/durationMs/insideMeasuredSilence/
  distToChunkBoundaryS`).
  **`cutInsideSilence` es un requisito del validador de cortes de clip
  (Task 12/13), NO parte de este spike:** aquí no existe en el código; el
  spike solo aporta el dato (`uncovered[]`). Regla a implementar allí:
  preferir fronteras de segmento; si el corte pedido cae dentro de un hueco
  medido como silencio, **no rechazarlo** — clamp al borde de segmento más
  cercano y marcarlo; nunca interpolar.

## F5 — veredicto incondicional

Reescrito en la cabecera y en §11: **GO para el MVP**, frase sin
condiciones; las cuatro «condiciones» de la Ronda 2 viven ahora en el
**bloque diferido** con owner y trigger (timestamps por palabra; clase GPU
no-NVIDIA con gate RTF ≤ 0.31; carga nueva < 2 s; chunking manual como
diagnóstico — producción = `return_timestamps: true`). Las 6 filas MVP pasan
(se añadió la fila de caché con 0 bytes re-descargados).

## F4 — sondas `Range: bytes=0-0` a huggingface.co: eliminadas

Sonda nueva (botón **«Carga sin remoto (F4, Ronda 3)»**, corrida
`load-local`), dos fases por corrida con `PerformanceResourceTiming` filtrado
por `huggingface.co|hf.co|jsdelivr.net`:

| Visita | Fase | Carga | Peticiones HF/cdn-lfs/jsdelivr | Intentos `/models/` |
|---|---|---|---|---|
| misma sesión | warm-default | 1,111 ms | **0** | 0 |
| misma sesión | local-only | 946 ms | **0** | 0 |
| **visita nueva** (pestaña fresca) | warm-default primero | **2,124 ms** (2.ª visita: 1,955 ms) | **2** (`tokenizer_config.json`, `preprocessor_config.json`; Σ 476 ms / 223 ms; 0 B) | 0 |
| **visita nueva** | **local-only PRIMERO** (contexto JS virgen) | **1,644 ms** (réplica: 1,718 ms) | **0** | 2 (metadata opcional: no bloquea) |
| visita nueva instrumentada (`btn-warm`, hooks F4 Ronda 2) | default | **2,487 ms** | 6 Range (Σ 1,417 ms; 0 B) — 32 lecturas de Cache API / 214 MB, ORT 1,443.8 ms, wasm 18.6 ms, `requestDevice` 26.1 ms | — |

- **`env.allowRemoteModels = false` + `env.allowLocalModels = true` +
  `env.localModelPath = "/models/"` FUNCIONA** en transformers.js 4.3.2: la
  `Cache API` se consulta primero (`hub.js` → `checkCachedResource`) y la
  carga completa sale **sin ninguna petición a huggingface.co/cdn-lfs** —
  **las sondas Range se eliminan: SÍ** (0 entradas `PerformanceResourceTiming`
  a HF en todas las fases local-only).
- **Carga nueva lograda: 1.64–1.72 s con 0 peticiones a HF** (frente a
  1.96–2.12 s con flags por defecto y a los 2.83 s instrumentados con
  1,240 ms de sondas de la Ronda 2 — el estado de caché de esa sesión dejaba
  6 ficheros sin servir desde caché; ahora son 2, con Σ 223–476 ms). Umbral
  **< 3 s (R12) intacto y cumplido**; el nice-to-have **< 2 s** se cumple con
  local-only (1.64–1.72 s) y se queda a 1.96–2.12 s con flags por defecto.
- **Primera visita con caché vacía (perfil nuevo):** no se midió (borrar la
  caché de 521 MB costaría ~20.7 s de re-descarga); en ese estado, con
  `allowRemoteModels=false` y ficheros ausentes, transformers.js 4.3.2 lanza
  exactamente `ModelFileNotFoundError: \`local_files_only=true\` or
  \`env.allowRemoteModels=false\` and file was not found locally at
  "/models/onnx-community/whisper-base/…"` (`node_modules/@huggingface/transformers/src/utils/hub.js:329-331`).
  Sin pesos commiteados, esa primera visita sigue necesitando red.
- **Alternativas documentadas** (también en `result.localLoad.alternatives`):
  Service Worker que intercepte las URLs del modelo y sirva desde la Cache
  API; `env.useBrowserCache` + `env.customCache`; servir
  `config`/`tokenizer`/ONNX desde `public/models/` (pesos **no** commiteados)
  apuntando `env.localModelPath`.
- **Límite de la sonda:** valida la **carga** (`pipeline()` OK, 0 HF) pero no
  ejecuta inferencia con ese pipeline (la fase `warm-default` lo reemplaza);
  validar WER con el pipeline local queda como follow-up.

## Menores

1. **`Rate = 0` (no `-2`):** verificado en `scripts/gen-audio.ps1:45`
   (`$synth.Rate = 0`); RESULT.md:79 decía `-2` → **corregido**. El audio NO
   se regeneró.
2. **Riesgo en equipos de 8 GB** (§13): pico UASM medido **1.16 GB** en caja
   de 32 GB; en 8 GB se espera swap (thrashing) y posible crash de pestaña
   (**riesgo sin medir, sin números inventados**); mitigaciones: fallback
   wasm, `whisper-tiny`, opt-in a la nube; disparador de banco 8 GB en el
   bloque diferido.

## Higiene de la Ronda 3

- `bun run typecheck` → **0**; `bun run build` → **0**.
- Diff limitado a `spikes/whisper-webgpu/` (`main.ts`, `index.html`,
  `README.md`, `RESULT.md`); sin dependencias nuevas, sin pesos ni WAV.
- Corridas nuevas en `__WHISPER_RESULTS__`: `selfcheck` (automática al
  cargar), `load-warm` (2,487 ms instrumentada), `segments` (unión),
  `manual-chunk` (fix) y `load-local` ×5 (sondas F4, incluida la de orden
  local-first); consola sin errores JS (solo warnings ORT conocidos y el
  `powerPreference` de siempre).
