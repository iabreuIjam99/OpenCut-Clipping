# RESULT — Spike WORKERFS + ffmpeg.wasm (Task 6)

**Veredicto: GO** — con una condición documentada: el comando de extracción lleva `-vbr off`
(CBR) para acotar el tamaño de salida. Con ella, **los cuatro umbrales R8 pasan** y el
plan B (WebCodecs + `webm-muxer`) **no** mejora ninguna métrica (mismo codificador Opus,
mismo rate control).

| Métrica (R8) | Umbral GO | Medido | Estado |
|---|---|---|---|
| 2 GB monta y extrae sin OOM | obligatorio | 2.310.941.040 B montados con WORKERFS; 2 ejecuciones completas (`exit 0`); pico de página 27,34 / 22,49 MB frente a cota de 4192 MB | **PASS** |
| 1 h de vídeo → audio en | < 180 s | **49.251 ms** (literal) / **47.750 ms** (CBR) | **PASS** |
| Tamaño de salida (1 h) | ≤ 15 MB | 18.001.893 B con el comando literal · **11.903.838 B con `-vbr off`** | **PASS con flag** (literal: 18,00 MB → ver §7) |
| Pestaña sobrevive (sin crash) | obligatorio | 4 ejecuciones completas, sin OOM ni crash | **PASS** |

---

## 1. Entorno

| Componente | Valor |
|---|---|
| SO | Windows 11 IoT Enterprise LTSC (10.0.26100.9711) |
| CPU | AMD Ryzen 5 9600X — 6 núcleos / 12 hilos (`navigator.hardwareConcurrency` = 12) |
| GPU | AMD Radeon (TM) Graphics |
| RAM | 32 GB (`navigator.deviceMemory`, cota declarada por el SO) |
| Navegador | Chrome **156.0.0.0** (desktop, UA `Mozilla/5.0 … Chrome/156.0.0.0 Safari/537.36`) |
| `crossOriginIsolated` | **true** (COOP `same-origin` + COEP `require-corp`, verificados con `curl -I`) |
| `jsHeapSizeLimit` | 4192 MB |
| API de memoria | `performance.measureUserAgentSpecificMemory()` disponible (Chrome la expone como `{bytes, breakdown}`) |
| Runtime de build | Bun 1.3.11 (spike autocontenido, sin tocar raíz/`apps/*`) |

## 2. Core, códecs y cadena R3

- **Core usado:** `@ffmpeg/core@0.12.10` **single-thread** (ESM) + `@ffmpeg/ffmpeg@0.12.15`.
- **`ffmpeg.exec(["-version"])`:** `ffmpeg version 5.1.4 Copyright (c) 2000-2023 the FFmpeg developers`.
- **`load()` del core:** 56 ms.
- **Cadena R3:** se paró en **R3.1** — el core single-thread **sí trae `libopus`**
  (`hasLibopus: true`), no hizo falta `@ffmpeg/core-mt` ni el fallback `libmp3lame`
  (`hasLibmp3lame: true` queda registrado como disponible). Prueba registrada en UI:
  `R3.1: @ffmpeg/core@0.12.10 single-thread trae libopus → "-c:a libopus -b:a 24k -f webm"`.
- **Evidencia (`ffmpeg.exec(["-encoders"])`, 76 encoders de audio):**

  ```
  aac, ac3, ac3_fixed, adpcm_adx, adpcm_argo, g722, g726, g726le, adpcm_ima_alp,
  adpcm_ima_amv, adpcm_ima_apm, adpcm_ima_qt, adpcm_ima_ssi, adpcm_ima_wav,
  adpcm_ima_ws, adpcm_ms, adpcm_swf, adpcm_yamaha, alac, aptx, aptx_hd, comfortnoise,
  dfpwm, dca, eac3, flac, g723_1, mlp, mp2, mp2fixed, libmp3lame, nellymoser, opus,
  libopus, pcm_alaw, pcm_bluray, pcm_dvd, pcm_f32be, pcm_f32le, pcm_f64be, pcm_f64le,
  pcm_mulaw, pcm_s16be, pcm_s16be_planar, pcm_s16le, pcm_s16le_planar, pcm_s24be,
  pcm_s24daud, pcm_s24le, pcm_s24le_planar, pcm_s32be, pcm_s32le, pcm_s32le_planar,
  pcm_s64be, pcm_s64le, pcm_s8, pcm_s8_planar, pcm_u16be, pcm_u16le, pcm_u24be,
  pcm_u24le, pcm_u32be, pcm_u32le, pcm_u8, pcm_vidc, real_144, roq_dpcm, s302m, sbc,
  sonic, sonicls, truehd, tta, vorbis, libvorbis, wavpack, wmav1, wmav2
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
| `fixtures/medium-10min.mp4` | 520.083.000 | 496 MiB | 600 s |
| `fixtures/large-2gb.mp4` | **2.310.941.040** | **2,15 GiB** (> 2^31) | 3600 s |

Ninguno se commitea (`.gitignore`: `node_modules/`, `fixtures/`, `dist/`, `public/`, `*.log`).

**Calidad del contenido (control nativo, `astats`):** el audio del fixture es
`sine=frequency=440` pasado por el AAC nativo de ffmpeg (`-b:a 128k`). El seno lavfi
puro mide crest 1,414 (PCM directo); la cadena `sine → AAC` mide **crest 2,142**
(pico −14,46 dB, RMS −21,08 dB) — idéntico al del fixture en disco, y un FLAC 16 kHz
mono del fixture ocupa **616.193 B / 30 s (164 kbps)**, o sea que el audio decodificado
**no** es un seno simple para los codificadores. Esto explica el comportamiento de
tamaño de §7 y es reproducible con el comando del script.

## 4. Métricas — ejecuciones reales en Chrome (Task 6)

Comando de extracción (literal, R2/Step 2 — **sin ningún `writeFile` del vídeo**):

```
ffmpeg.exec(["-i", "/input/<fixture>.mp4", "-vn", "-ac", "1", "-ar", "16000",
             "-c:a", "libopus", "-b:a", "24k", "-f", "webm", "/output/audio.webm"])
```

Variante CBR (checkbox «forzar CBR»): se añade `"-vbr", "off"` antes de `-f`.
Montaje siempre igual: `ffmpeg.mount("WORKERFS", { files: [file] }, "/input")`.

| Run | Entrada (B) | mount (ms) | exec (ms) | Salida (B) | Salida (MB) | Duración salida (ms) | Pico JS heap (MB)* | Pico página (MB) | Log msgs | Resultado |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `short-30s` | 1.764.861 | 0,27 | **199** | 148.139 | 0,148 | 30.000 | 3,50 | —** | 8.304 | OK, exit 0 |
| `medium-10min` | 520.083.000 | 0,105 | **10.006** | 2.999.666 | 3,00 | 600.004 | 9,75 | 9,88 | 161.884 | OK, exit 0 |
| `large-2gb` (literal) | 2.310.941.040 | 0,12 | **49.251** | 18.001.893 | **18,00** | 3.600.022 | 27,56 | 27,34 | 970.157 | OK, exit 0 |
| `large-2gb` (CBR) | 2.310.941.040 | 0,275 | **47.750** | **11.903.838** | **11,90** | 3.600.022 | 28,15 | 22,49 | 970.155 | OK, exit 0 |

- `outputMime` = `audio/webm` en los 4 runs; duración verificada con
  `AudioContext.decodeAudioData` (30.000 / 600.004 / 3.600.022 ms — coincide con la
  duración del vídeo de entrada).
- \* `performance.memory.usedJSHeapSize` muestreado cada 250 ms: **cota inferior**
  del uso real (documentado en la UI). El dato completo es el de «pico página»
  (`measureUserAgentSpecificMemory`, muestreo igual cada 250 ms).
- \** En `short-30s` la ejecución dura 199 ms (< un intervalo de muestreo), sin
  muestra de página.
- Desglose de memoria de los runs de 1 h: entrada máxima de 22.010.906 B (literal) y
  16.750.757 B (CBR) — **el fichero de 2,15 GiB nunca reside completo en el proceso**;
  WORKERFS lee por `slice` bajo demanda.
- Persistencia: resultados a `localStorage` cada 10 s; una caída de pestaña deja un run
  en `RUNNING` recuperable como `INTERRUPTED`.

## 5. Controles nativos (`ffmpeg-static`, mismo comando) — ¿es la arquitectura?

Sobre `fixtures/short-30s.mp4` (30 s), binario nativo:

| Comando nativo | Bytes (30 s) | Extrapolado ×120 (1 h) | Browser (1 h) |
|---|---:|---:|---:|
| literal (`libopus -b:a 24k` VBR) | **148.088** | 17,77 MB | **18.001.893 B** ✓ |
| literal + `-vbr off` (CBR) | **99.937** | 11,99 MB | **11.903.838 B** ✓ |
| `-b:a 16k` VBR | 79.394 | 9,53 MB | — |
| `-c:a flac -ac 1 -ar 16000` | 616.193 | — | — |

**El nativo y el WASM coinciden byte a byte** (148.088 vs 148.139 → 51 B, 0,03 %).
El tamaño de salida es una propiedad del contenido + rate control de Opus, **no** de
WORKERFS/ffmpeg.wasm.

## 6. ¿Cómo se comporta la memoria? (R5)

- `mount`: **≤ 0,28 ms** en los 4 runs — WORKERFS referencia el `File` del navegador;
  no hay copia del vídeo al FS (ni `writeFile`, prohibido por R2).
- Pico de página para 2,15 GiB de entrada: **27,34 MB** (literal) / **22,49 MB** (CBR)
  frente a `jsHeapSizeLimit` 4192 MB → **margen de ~150×**; sin OOM.
- JS heap pico: 27,56 / 28,15 MB (cota inferior, muestreo 250 ms).
- La UI muestra versión de ffmpeg, tiempos, bytes, MIME, duración decodificada, picos,
  errores y logs visibles; un botón por fixture y botón «Limpiar»
  (`unmount` + `deleteDir` + `deleteFile`).

## 7. Análisis del umbral de tamaño (15 MB) y por qué `-vbr off`

Hechos:

1. El comando literal con VBR produce **18,00 MB** para 1 h → **no** cumple ≤ 15 MB.
2. El VBR de Opus a target 24 kbps consume **~40 kbps de media** sobre este contenido
   (148.088 B/30 s = 39,5 kbps) → desvío ×1,65. Es reproducible **nativamente**
   (148.088 B) y el contenido tiene la responsabilidad: la cadena `sine → AAC` deja
   crest 2,142 y un FLAC de 164 kbps (§3).
3. **`-vbr off` (CBR) acota el tamaño de forma determinista**: 24 kbps × 3600 s / 8 =
   10,8 MB teóricos + contenedor ≈ **11,90 MB medidos en browser** (y 11,99 MB
   nativos), sea cual sea el contenido → **≤ 15 MB garantizado**.
4. En VBR con target más bajo el peor caso sigue sin estar acotado; en CBR, sí.

Por tanto: la condición de tamaño se cumple **con el flag documentado**, y el fallo del
comando literal es un parámetro del codificador, no un defecto de la arquitectura.

## 8. Plan B (WebCodecs + `webm-muxer`) — por qué NO se activa

R8 exige plan B si algún umbral falla. Con el comando de extracción documentado
(`-vbr off`), **ningún umbral falla**. Además, el plan B **no corregiría** el peor caso
de tamaño: usaría el mismo codificador Opus con el mismo rate control VBR (el Opus de
WebCodecs en Chrome es libopus), así que el ×1,65 de overshoot sobre este contenido
aparecería igual; solo añadiría complejidad (decodificar con WebCodecs + muxear a mano)
sin mejorar tiempo, memoria ni tamaño. Si en el futuro se necesitara VBR por calidad,
la vía correcta es un target inferior (`-b:a 16k` → 9,53 MB/h medido) o segmentar el
archivo, **no** cambiar de arquitectura.

## 9. Notas de implementación (para la fase real)

- **Logs:** ffmpeg.wasm imprime por debajo de `info`; 1 h genera **970.157 mensajes**
  (la UI los descarta en bloques de 500 para no reflowear). En producción: filtrar por
  nivel (`-loglevel error`) o no encolar el debug.
- **Core ESM + `classWorkerURL`:** `@ffmpeg/ffmpeg` crea su worker con
  `{type:"module"}`; el core se sirve desde `public/` (copiado en `vite.config.ts`)
  porque Vite reescribiría `ffmpeg-core.js` con su transform middleware. Ver
  `vite.config.ts` para el detalle.
- **Punto de montaje:** Emscripten exige que exista el directorio → `ensureDir("/input")`
  antes de `ffmpeg.mount` (sin ello: `ErrnoError: FS error`).
- **Cabeceras COOP/COEP/CORP** en el dev server (R6) y puerto **5175 --strictPort**.

## 10. Reproducción

```powershell
cd spikes\workerfs
bun install
bun run fixtures      # genera los 3 fixtures con ffmpeg-static (los dos grandes, varios min)
bun run dev           # http://localhost:5175 (COOP/COEP, strictPort)
# UI: cargar el fichero del fixture → «Extraer audio» (checkbox CBR opcional)
# Automatización: window.__SPIKE_RESULTS__ (JSON) y marcadores «RUN_DONE: …» en #markers
bun run typecheck     # tsc --noEmit
```

Evidencia automatizada de esta corrida: `window.__SPIKE_RESULTS__` con 4 entradas
(3 fixtures + `large-2gb` CBR), todas `outcome: "OK"`, `exitCode: 0`.
