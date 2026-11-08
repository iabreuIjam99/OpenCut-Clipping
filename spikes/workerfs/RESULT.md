# RESULT — Spike WORKERFS + ffmpeg.wasm (Task 6)

**Veredicto: GO** — incondicional. Los cuatro criterios de aceptación de Task 6 pasan
con el **comando de producción** (`-ac 1 -ar 16000 -c:a libopus -b:a 24k -vbr off -f
webm`, ADR-02 / `plan.md` Task 6 Step 2) y con la **medición de memoria** ejecutada con
`performance.measureUserAgentSpecificMemory()` (UASM). El plan B (WebCodecs +
`webm-muxer`) **no** se activa: ningún umbral falla (ver §9).

| Criterio de aceptación (Task 6 / R8) | Umbral GO | Medido con el comando de producción | Estado |
|---|---|---|---|
| 2 GB monta y extrae sin OOM | obligatorio | 2.310.941.040 B montados con WORKERFS (`mount` 0,13 ms); `exit 0`; **pico UASM 28,05 MB** frente a cota `jsHeapSizeLimit` 4192 MB (margen ×149) | **PASS** |
| 1 h → audio en < 3 min | < 180.000 ms | **59.751 ms** de `exec` (1 h); 12.733 ms (10 min); 231 ms (30 s). Pared total de la corrida de 1 h ≈ 68 s (incluida la medición UASM final) | **PASS** |
| Tamaño de salida (1 h) | ≤ 15.000.000 B | **11.903.838 B** = 11,90 MB (10⁶) / 11,35 MiB; extrapolado **11.903.765 B/h** | **PASS** |
| Pestaña sobrevive (sin crash) | obligatorio | **8 ejecuciones completas** `exit 0`, sin OOM ni crash de pestaña | **PASS** |

Unidad: «MB» = 10⁶ B (el umbral de 15 MB se cumple también leyéndolo como 15 MiB:
11,99 MB = 11,44 MiB es el peor caso).

---

## 1. Entorno

| Componente | Valor |
|---|---|
| SO | Windows 11 IoT Enterprise LTSC (10.0.26100.9711) |
| CPU | AMD Ryzen 5 9600X — 6 núcleos / 12 hilos (`navigator.hardwareConcurrency` = 12) |
| GPU | AMD Radeon (TM) Graphics |
| RAM | 32 GB (`navigator.deviceMemory`, cota declarada por el SO) |
| Navegador | Chrome **156.0.0.0** (desktop, UA `Mozilla/5.0 … Chrome/156.0.0.0 Safari/537.36`) |
| `crossOriginIsolated` | **true** (COOP `same-origin` + COEP `require-corp` + CORP `cross-origin`; verificados con `curl -I` sobre el dev server; ahora también en `preview`, ver §12) |
| `jsHeapSizeLimit` | 4192 MB |
| API de memoria | `performance.measureUserAgentSpecificMemory()` disponible; Chrome 156 devuelve `{ bytes, breakdown }` con `attribution: [{scope, url}]` y `types` |
| Latencia de la UASM | **10.023 ms por llamada en reposo** (cronometrada); hasta ~28 s bajo carga — limita la frecuencia de muestreo (ver §7) |
| Runtime de build | Bun 1.3.11 (spike autocontenido, sin tocar raíz/`apps/*`) |

## 2. Core, códecs y cadena R3

- **Core usado:** `@ffmpeg/core@0.12.10` **single-thread** (ESM) + `@ffmpeg/ffmpeg@0.12.15`.
- **`ffmpeg.exec(["-version"])`:** `ffmpeg version 5.1.4 Copyright (c) 2000-2023 the FFmpeg developers`.
- **`load()` del core:** 56–74 ms (mín/máx entre las corridas).
- **Cadena R3:** se paró en **R3.1** — el core single-thread **sí trae `libopus`**
  (`hasLibopus: true`), no hizo falta `@ffmpeg/core-mt` ni el fallback `libmp3lame`
  (`hasLibmp3lame: true` queda registrado como disponible). Prueba registrada en UI:
  `R3.1: @ffmpeg/core@0.12.10 single-thread trae libopus → "-c:a libopus -b:a 24k -f webm"`.
- **Evidencia (`ffmpeg.exec(["-encoders"])`, 76 encoders de audio):**

  ```
  aac, ac3, ac3_fixed, adpcm_adx, adpcm_argo, g722, g726, g726le, adpcm_ima_alp,
  adpcm_ima_amv, adpcm_ima_apm, adpcm_ima_qt, adpcm_ima_wav, adpcm_ima_ws,
  adpcm_ms, adpcm_swf, adpcm_yamaha, alac, aptx, aptx_hd, comfortnoise, dfpwm,
  dca, eac3, flac, g723_1, mlp, mp2, mp2fixed, libmp3lame, nellymoser, opus,
  libopus, pcm_alaw, pcm_bluray, pcm_dvd, pcm_f32be, pcm_f32le, pcm_f64be,
  pcm_f64le, pcm_mulaw, pcm_s16be, pcm_s16be_planar, pcm_s16le, pcm_s16le_planar,
  pcm_s24be, pcm_s24daud, pcm_s24le, pcm_s24le_planar, pcm_s32be, pcm_s32le,
  pcm_s32le_planar, pcm_s64be, pcm_s64le, pcm_s8, pcm_s8_planar, pcm_u16be,
  pcm_u16le, pcm_u24be, pcm_u24le, pcm_u32be, pcm_u32le, pcm_u8, pcm_vidc,
  real_144, roq_dpcm, s302m, sbc, sonic, sonicls, truehd, tta, vorbis, libvorbis,
  wavpack, wmav1, wmav2
  ```

  (la salida completa de `-encoders` —incluida la de vídeo— es visible en el panel
  «Log de ffmpeg» de la página; las execs de sondeo terminan con `Aborted()` en el log,
  salida de Emscripten al hacer `exit()`, sin efecto sobre la sonda).

## 3. Fixtures (generados localmente con `ffmpeg-static`, nunca descargados)

Comandos exactos (los ejecuta `bun run fixtures` → `scripts/gen-fixtures.ts`;
el binario es el de la devDependency `ffmpeg-static@5.3.0`, sin ffmpeg de sistema):

```powershell
# base (short-30s.mp4)
ffmpeg -y -hide_banner -nostdin `
  -f lavfi -i testsrc=size=1280x720:rate=30 `
  -f lavfi -i sine=frequency=440 `
  -t 30 -c:v libx264 -preset ultrafast -pix_fmt yuv420p `
  -c:a aac -b:a 128k -shortest -progress pipe:1 -nostats fixtures\short-30s.mp4

# medium-10min.mp4 → ídem con -t 600 + CBR forzado:
#   -b:v 6800k -maxrate 6800k -bufsize 6800k -x264-params nal-hrd=cbr
# large-2gb.mp4  → ídem con -t 3600 + CBR forzado:
#   -b:v 5000k -maxrate 5000k -bufsize 5000k -x264-params nal-hrd=cbr
```

El CBR forzado es deliberado: con ABR plano, `testsrc` se estanca en el suelo de QP de
x264 (~1,4 Mbps) y no se alcanzan los tamaños objetivo; con `nal-hrd=cbr` el tamaño es
determinista (`bitrate × duración`).

| Fichero (en disco) | Bytes | Tamaño | Duración |
|---|---:|---:|---:|
| `fixtures/short-30s.mp4` | 1.764.861 | 1,68 MiB | 30 s |
| `fixtures/medium-10min.mp4` | 520.083.000 | 496 MiB (~500 MB) | 600 s |
| `fixtures/large-2gb.mp4` | **2.310.941.040** | **2,15 GiB** (> 2³¹) | **3.600 s** |

**`large-2gb.mp4` es UN solo fixture que cubre ambos umbrales de Step 3** («probar con
500 MB, 2 GB y un fichero de 1 h»): pesa **2.310.941.040 B ≥ 2 GB** y dura
**3.600.000 ms = 1 h** exacta. No existe un fixture «1 h» separado pendiente: no es una
laguna sin medir. El paso de 500 MB lo cubre `medium-10min` (520.083.000 B) y el de
2 GB + 1 h, `large-2gb`. Ninguno se commitea (`.gitignore`: `node_modules/`,
`fixtures/`, `dist/`, `public/`, `*.log`).

**Calidad del contenido (control nativo, `astats`):** el audio del fixture es
`sine=frequency=440` pasado por el AAC nativo de ffmpeg (`-b:a 128k`). El seno lavfi
puro mide crest 1,414 (PCM directo); la cadena `sine → AAC` mide **crest 2,142**
(pico −14,46 dB, RMS −21,08 dB) — idéntico al del fixture en disco, y un FLAC 16 kHz
mono del fixture ocupa **616.193 B / 30 s (164 kbps)**, o sea que el audio decodificado
**no** es un seno simple para los codificadores. Esto explica el comportamiento de
tamaño de §8 y es reproducible con el comando del script.

## 4. Métricas CBR — comando de producción en Chrome (soporta el GO)

Comando ejecutado en las tres corridas (**sin ningún `writeFile` del vídeo**):

```
ffmpeg.exec(["-i", "/input/<fixture>.mp4", "-vn", "-ac", "1", "-ar", "16000",
             "-c:a", "libopus", "-b:a", "24k", "-vbr", "off",
             "-f", "webm", "/output/audio.webm"])
```

Montaje siempre igual: `ffmpeg.mount("WORKERFS", { files: [file] }, "/input")`.
`-vbr off` es ahora el comportamiento por defecto del spike (ADR-02); el checkbox de la
UI es solo un diagnóstico que reintenta el comando literal sin el flag (§5).

| Run (producción) | Entrada (B) | mount (ms) | exec (ms) | Salida (B) | B/s | Extrapolado B/h | Duración salida (ms) | MIME | exit |
|---|---:|---:|---:|---:|---:|---:|---:|---|---:|
| `short-30s-cbr` | 1.764.861 | 0,29 | **231** | **99.938** | 3.331,27 | 11.992.560 (11,99 MB) | 30.000 | `audio/webm` | **0** |
| `medium-10min-cbr` | 520.083.000 | 0,29 | **12.733** | **1.984.572** | 3.307,60 | 11.907.353 (11,91 MB) | 600.004 | `audio/webm` | **0** |
| `large-2gb-cbr` | 2.310.941.040 | 0,13 | **59.751** | **11.903.838** | 3.306,60 | 11.903.765 (11,90 MB) | 3.600.022 | `audio/webm` | **0** |

- `outcome: "OK"` en los tres casos; duración verificada con
  `AudioContext.decodeAudioData` (30.000 / 600.004 / 3.600.022 ms — coincide con la
  duración del vídeo de entrada: el archivo se procesó **entero**).
- Reejecución de verificación con el código final (`short-30s-cbr`, 8.ª entrada):
  `exec 226 ms`, salida **99.938 B** — byte a byte idéntico, `exit 0`.
- Corrida CBR previa a la instrumentación (round 0, conservada):
  `large-2gb-cbr` = **11.903.838 B en 47.750 ms** — bytes idénticos a los de arriba:
  el CBR es determinista, el `exec` varía con la carga de muestreo.
- Persistencia: resultados a `localStorage` cada 10 s; una caída de pestaña deja un run
  en `RUNNING` recuperable como `INTERRUPTED`.

## 5. Comparativa — comando literal VBR (por qué NO soporta el umbral)

Mismos fixtures con el comando literal (**sin** `-vbr off`), conservado como evidencia
de por qué ese comando no puede sostener el veredicto:

| Run literal | Salida (B) | B/s | Extrapolado B/h | Cumple ≤ 15 MB |
|---|---:|---:|---:|---|
| `short-30s` | 148.139 | 4.937,97 | 17.776.800 (17,78 MB) | **NO** |
| `medium-10min` | 2.999.666 | 4.999,41 | 17.997.876 (18,00 MB) | **NO** |
| `large-2gb` (exec 49.251 ms, exit 0) | 18.001.893 | 5.000,50 | 18.001.783 (18,00 MB) | **NO** |

El VBR de Opus a target 24 kbps consume ~40 kbps de media sobre este contenido
(148.088 B/30 s = 39,5 kbps) → desvío ×1,65. Es reproducible **nativamente** (§6) y es
una propiedad del contenido + rate control, no de la arquitectura. Con `-vbr off` el
tamaño queda acotado de forma determinista y **ninguna fila de §4 supera 15 MB**.

## 6. Controles nativos (`ffmpeg-static`, mismo comando) — ¿es la arquitectura?

Sobre `fixtures/short-30s.mp4` (30 s), binario nativo:

| Comando nativo | Bytes (30 s) | Extrapolado ×120 (1 h) | Browser (1 h) |
|---|---:|---:|---:|
| literal (`libopus -b:a 24k` VBR) | **148.088** | 17,77 MB | **18.001.893 B** ✓ |
| literal + `-vbr off` (CBR) | **99.937** | 11,99 MB | **11.903.838 B** ✓ |
| `-b:a 16k` VBR | 79.394 | 9,53 MB | — |
| `-c:a flac -ac 1 -ar 16000` | 616.193 | — | — |

**El nativo y el WASM coinciden casi byte a byte**: 148.088 vs 148.139 (VBR, 51 B,
0,03 %) y 99.937 vs 99.938 (CBR, **1 B**). El tamaño de salida es una propiedad del
contenido + rate control de Opus, **no** de WORKERFS/ffmpeg.wasm.

## 7. Memoria (R5) — `measureUserAgentSpecificMemory` es la única prueba de «sin OOM»

### 7.1 Qué mide cada número (etiquetas de la UI)

- **`performance.measureUserAgentSpecificMemory()` (UASM): total de memoria del agente
  (página + workers + DOM + compartida), medida tras GC. ES EL ÚNICO número que soporta
  «sin OOM».** Se muestrea en periodo y se toma una **medición final esperada (await)
  tras `exec`, antes de parar el sampler**; sus campos son `pageFinalBytes`,
  `pageFinalBreakdown` y `pageFinalError` en `window.__SPIKE_RESULTS__`.
- **`performance.memory.usedJSHeapSize`: cota inferior NO usable para el veredicto.**
  Solo el JS del hilo principal, es un contador crudo que incluye basura sin GC y no
  incluye el worker ni el heap de WASM. Por eso puede incluso superar el total UASM
  (medium: 13,14 MB de JS heap frente a 6,78 MB de UASM post-GC) o quedar por debajo
  (large: 24,07 vs 28,05 MB). No se compara ni se cita para el veredicto.

### 7.2 Frecuencia alcanzada y comportamiento de la API

- Muestreo periódico **adaptativo**: arranque cada 2.000 ms; ×0,75 por éxito (mínimo
  1.000 ms) y ×2 por rechazo (tope 30.000 ms) — converge a la máxima frecuencia que la
  API tolere. El intervalo nominal final queda en `pageSampleIntervalMs`.
- **Latencia real medida: 10.023 ms por llamada en reposo** (llamada manual
  cronometrada tras una corrida); en la corrida de 1 h las llamadas bajo carga
  tardaron ~28 s. La frecuencia **alcanzada** fue, por tanto, ≈ **1 muestra cada
  10–18 s** (corridas cortas) y ≈ **1 cada 28 s** en la de 1 h — no la nominal de
  1–2 s, que es solo el intervalo entre intentos.
- **Rechazos de la API: 0 en las tres corridas** (`pageRejected: 0`,
  `pageFirstError: null`). Chrome 156 no devolvió errores de cuota ni `SecurityError`;
  la restricción observada fue la **latencia**, no el límite de frecuencia. El
  registro de rechazos existe y está publicado por si otra versión de Chrome lo activa
  (el intervalo se duplicaría y quedaría asentado en `pageRejected`/`pageFirstError`).

### 7.3 Resultados por corrida (producción CBR)

| Run | UASM pico (B) | UASM pico (MB) | UASM final tras `exec` (B) | `pageFinalError` | Muestras UASM | Rechazos | Intervalo final | JS heap pico (MB)* |
|---|---:|---:|---:|---|---:|---:|---:|---:|
| `short-30s-cbr` | 5.196.162 | 4,96 | 5.196.162 | `null` | 1 | 0 | 1.500 ms | 5,29 |
| `medium-10min-cbr` | 7.111.044 | 6,78 | 7.111.044 | `null` | 1 | 0 | 1.500 ms | 13,14 |
| `large-2gb-cbr` | **29.415.197** | **28,05** | **29.415.197** | `null` | 2 | 0 | 1.125 ms | 24,07 |

\* Cota inferior (§7.1), no se usa para el veredicto. Pico = máximo de las muestras
periódicas y la final; en las tres corridas el pico lo aportó la medición final.

### 7.4 Desglose por URL — corrida de 1 h (`large-2gb-cbr`, total 29.415.197 B)

| URL / atribución | `scope` | `types` | Bytes | % del total |
|---|---|---|---:|---:|
| `http://localhost:5175/ffmpeg/worker.js` | `DedicatedWorkerGlobalScope` | JavaScript | **14.139.731** | 48,1 % |
| `http://localhost:5175/` | `Window` | JavaScript | **13.886.023** | 47,2 % |
| (sin url) | — | Shared | 1.326.595 | 4,5 % |
| (sin url) | — | DOM | 62.848 | 0,2 % |
| (sin url) | — | (entrada vacía) | 0 | 0 % |
| **Total** | | | **29.415.197** | **100 %** |

- **El worker de ffmpeg SÍ está incluido** (entrada `ffmpeg/worker.js`, alcance
  `DedicatedWorkerGlobalScope`) — no se omite. El **heap de WASM no aparece como URL
  `.wasm` aparte**: UASM atribuye el `ArrayBuffer` de `WebAssembly.Memory` al contexto
  que lo posee, o sea a esa misma entrada JavaScript del worker. El total cubre
  página + worker + DOM + memoria compartida del agente, post-GC.
- Composición coherente con el flujo: la salida de 11.903.838 B reside **dos veces**
  al final de la corrida (en MEMFS del worker → entrada `worker.js`; y como copia
  leída en la página para `decodeAudioData`/subida → entrada `Window`), más el motor
  (wasm + core + app) ≈ 5,6 MB. Descontando esas dos copias transitorias, el uso
  estable del «motor» es de solo unos MB.

### 7.5 ¿Qué prueba este número y qué NO?

**Prueba:** que durante 2,15 GiB de entrada y 1 h de contenido la memoria total del
agente llegó a **28,05 MB** (pico, con medición final esperada tras `exec`) frente a
`jsHeapSizeLimit` 4192 MB → **margen ×149, sin OOM**, con `exit 0` y salida completa.
El muestreo cubre el inicio, el transcurso y el fin de la corrida.

**No prueba:** (a) memoria fuera del navegador (proceso del SO, disco, caché);
(b) el desglose no separa «wasm» de «JS del worker» ni distingue MEMFS dentro de esa
entrada; (c) al ser la latencia de la API de 10–28 s por llamada, un pico **entre**
muestras podría no capturarse — aunque el pico observado está a ×149 de la cota; (d)
`usedJSHeapSize` no cubre nada de esto y no se usa (§7.1).

### 7.6 Saneidad: ¿2,15 GiB de entrada en 28,05 MB de página? (prueba de streaming)

1. `mount` = **0,13 ms**: WORKERFS referencia el `File` del navegador; copiar
   2,15 GiB en 0,13 ms es imposible — no hay copia (y `writeFile` está prohibido).
2. Log de la propia corrida: `Statistics: 2309948184 bytes read, 33 seeks` — ffmpeg
   leyó **bajo demanda, con seeks**, desde el FS montado.
3. Duración de salida **3.600.022 ms** = 100 % del contenido: procesó el archivo
   entero sin residirlo.
4. Desglose: la entrada mayor es de **14,14 MB** (worker) y el total de 28,05 MB es
   **1,2 %** del input. Ninguna entrada ni el total se acercan a 2,15 GiB.
5. El grueso del total son las dos copias de la **salida** (11,9 MB × 2, §7.4), no
   la entrada.

## 8. Análisis del umbral de tamaño (15 MB) y por qué `-vbr off`

Hechos:

1. El comando literal con VBR produce **18,00 MB** para 1 h → **no** cumple ≤ 15 MB
   (§5).
2. El VBR de Opus a target 24 kbps consume **~40 kbps de media** sobre este contenido
   (148.088 B/30 s = 39,5 kbps) → desvío ×1,65. Es reproducible **nativamente**
   (148.088 B) y el contenido tiene la responsabilidad: la cadena `sine → AAC` deja
   crest 2,142 y un FLAC de 164 kbps (§3).
3. **`-vbr off` (CBR) acota el tamaño de forma determinista**: 24 kbps × 3600 s / 8 =
   10,8 MB teóricos + contenedor ≈ **11,90–11,99 MB medidos en browser** (y 11,99 MB
   nativos), sea cual sea el contenido → **≤ 15 MB garantizado** (§4).
4. En VBR con target más bajo el peor caso sigue sin estar acotado; en CBR, sí.

El comando literal es un parámetro del codificador, no un defecto de la arquitectura;
el comando de producción (con `-vbr off`) cumple el umbral en las tres corridas.

## 9. Plan B (WebCodecs + `webm-muxer`) — por qué NO se activa

R8 exige plan B si algún umbral falla. **Ningún umbral falla** (tabla de cabecera).
Además, el plan B **no corregiría** el peor caso de tamaño: usaría el mismo codificador
Opus con el mismo rate control VBR (el Opus de WebCodecs en Chrome es libopus), así que
el ×1,65 de overshoot sobre este contenido aparecería igual; solo añadiría complejidad
(decodificar con WebCodecs + muxear a mano) sin mejorar tiempo, memoria ni tamaño. Si
en el futuro se necesitara VBR por calidad, la vía correcta es un target inferior
(`-b:a 16k` → 9,53 MB/h medido) o segmentar el archivo, **no** cambiar de
arquitectura.

## 10. Notas de implementación (para la fase real)

- **Logs:** ffmpeg.wasm imprime por debajo de `info`; 1 h genera **970.183 mensajes**
  (la UI los descarta en bloques de 500 para no reflowear). En producción: filtrar por
  nivel (`-loglevel error`) o no encolar el debug.
- **Core ESM + `classWorkerURL`:** `@ffmpeg/ffmpeg` crea su worker con
  `{type:"module"}`; el core se sirve desde `public/` (copiado en `vite.config.ts`)
  porque Vite reescribiría `ffmpeg-core.js` con su transform middleware. Ver
  `vite.config.ts` para el detalle.
- **Punto de montaje:** Emscripten exige que exista el directorio → `ensureDir("/input")`
  antes de `ffmpeg.mount` (sin ello: `ErrnoError: FS error`).
- **Cabeceras COOP/COEP/CORP** en `server` **y `preview`** de `vite.config.ts` (R6) y
  puerto **5175 --strictPort**; sin ellas `crossOriginIsolated` es `false` y la UASM no
  corre.
- **Limpieza:** «Limpiar» hace `unmount` + `deleteFile` de la salida +
  `deleteDir("/output")` **y `deleteDir("/input")`** (tolerando que no exista).
- **Unidades:** `mountMs`/`execMs`/`outputDurationMs`/`loadMs` siempre en **ms**;
  tamaños en **B** con conversión MB (10⁶) / MiB explícita; `RUN_DONE: … exec=<ms>ms
  mount=<ms>ms out=<bytes>B`.

## 11. Reproducción

```powershell
cd spikes\workerfs
bun install
bun run fixtures      # genera los 3 fixtures con ffmpeg-static (los dos grandes, varios min)
bun run dev           # http://localhost:5175 (COOP/COEP/CORP, strictPort)
# UI: cargar el fichero del fixture → «Extraer audio»
#     (por defecto: comando de producción con -vbr off;
#      el checkbox es diagnóstico con el comando literal sin -vbr off)
# Automatización: window.__SPIKE_RESULTS__ (JSON) y marcadores «RUN_DONE: …» en #markers
bun run typecheck     # tsc --noEmit
```

Evidencia automatizada: `window.__SPIKE_RESULTS__` con **8 entradas**, todas
`outcome: "OK"` y `exitCode: 0` — 3 literales VBR (§5), 1 CBR previa (round 0) y
**4 CBR de producción** (3 fixtures de §4 + reejecución de verificación). Campos de
memoria por entrada: `peakPageMemoryMB`, `pageBreakdown`, `pageFinalBytes`,
`pageFinalBreakdown`, `pageFinalError`, `pageSamples`, `pageRejected`,
`pageFirstError`, `pageSampleIntervalMs`, `peakJsHeapMB` (cota inferior),
`memorySamples` (ticks de 250 ms), `pageMemoryError`.

## 12. Fix round 1 (hallazgos del revisor → resueltos)

- **F1 (re-medición con el comando de producción):** las tres corridas de §4 se
  repitieron con `-vbr off` y publican bytes/s, bytes/h, `exec` en ms, duración, MIME
  y `exit`. Las corridas literales VBR se conservan separadas en §5 («por qué falla
  el umbral»). §3 declara explícitamente que `large-2gb.mp4` (2.310.941.040 B,
  3.600 s) **es un único fixture que cubre ambos umbrales** — no es una laguna.
- **F2 (la memoria ahora prueba «sin OOM»):** medición UASM **final esperada tras
  `exec` y antes de `stopSampler`** (campos `pageFinal*` en `__SPIKE_RESULTS__`);
  muestreo periódico adaptativo con registro de rechazos (`pageRejected`,
  `pageFirstError`, `pageSampleIntervalMs`) y frecuencia alcanzada declarada (§7.2);
  desglose **por URL** publicado — con la forma real de Chrome 156
  (`attribution[{scope,url}]` + `types`; antes salía «(sin url)») —, incluida la
  entrada del worker (§7.4); UASM etiquetada como único soporte de «sin OOM» y
  `usedJSHeapSize` como cota inferior no usable (§7.1); saneidad de 2,15 GiB vs
  28,05 MB con evidencia de streaming (§7.6). Bug encontrado y corregido en la ronda:
  la espera de la UASM final contaminaba `execMs` (marcaba 12.508 ms en vez de
  231 ms) → reloj bloqueado tras `exec`. Red de seguridad de 60 s en la medición
  final (no saltó en ninguna corrida).
- **F3 (veredicto):** reescrito como **GO** sin condicionales, justificado por la
  tabla CBR (§4) y la medición de memoria (§7).
- **Menores:**
  1. `vite.config.ts`: cabeceras COOP/COEP/CORP añadidas a `preview` (antes solo
     `server`); verificadas con `curl -I` (§1).
  2. `cleanAll()` borra ahora también `/input` (tolerando «no existe») (§10).
  3. Auditoría de unidades: `exec`/`mount`/duraciones en ms con etiqueta, tamaños en
     B con MB/MiB explícitos, marcador `RUN_DONE` con `mount=<ms>ms` (antes redondeaba
     a `0ms` sub-ms) y `exec` entero en ms.
  4. Erratas corregidas: nota al pie malformada `—**` en la tabla de métricas;
     afirmación falsa «muestreo igual cada 250 ms» para la UASM (era cada 10 s —
     de ahí perdía el máximo); «si el arquitectura» en `index.html`.
