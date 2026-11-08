# Spike: WORKERFS + ffmpeg.wasm (MonetizaClip)

Spike desechable (Task 6) que responde a la pregunta Go/No-Go: **¿se puede montar un
fichero de vídeo del usuario en el FS de ffmpeg con `WORKERFS` — sin `writeFile` — y
extraer su audio (Opus 16 kHz mono) en Chrome de escritorio sin OOM, en < 3 min para
1 h de vídeo y con salida ≤ 15 MB?**

**Resultado: ver [`RESULT.md`](./RESULT.md)** — **veredicto GO** con el comando de
producción (`-ac 1 -ar 16000 -c:a libopus -b:a 24k -vbr off -f webm`).

## Arranque

```powershell
cd spikes\workerfs
bun install        # dependencias propias del spike (sin workspaces, sin tocar apps/*)
bun run fixtures   # genera ./fixtures con el binario de ffmpeg-static (nunca descargados)
bun run dev        # http://localhost:5175  (strictPort; si está ocupado, falla en vez de saltar)
bun run typecheck  # tsc --noEmit
```

El servidor Vite añade `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp` y `Cross-Origin-Resource-Policy:
cross-origin` (necesarios para `SharedArrayBuffer` y para
`performance.measureUserAgentSpecificMemory`) — tanto en `server` como en
`preview` (`bun run build && bun run preview`; verificados con `curl -I`).

## Uso

1. «Recargar core» (o dejar el default `@ffmpeg/core` single-thread) → comprueba que
   la sección *Core y códecs* muestre `libopus`.
2. En *Ejecuciones*, pulsa el botón de fichero de un fixture y selecciona el MP4 de
   `./fixtures/`:
   - `short-30s.mp4` — calentamiento
   - `medium-10min.mp4` — ~500 MB / 10 min
   - `large-2gb.mp4` — **2,15 GiB / 1 h — la prueba crítica**
3. «Extraer audio». La página monta con `ffmpeg.mount("WORKERFS", { files: [file] },
   "/input")` (**nunca** escribe el vídeo en el FS), ejecuta la extracción y muestra:
   versión de ffmpeg, ms de `mount`, ms de `exec`, bytes + MIME de la salida, duración
   decodificada (`AudioContext.decodeAudioData`), memoria (UASM final esperada tras
   `exec` + muestreo periódico adaptativo; el JS heap solo como cota inferior),
   logs y errores.
4. Checkbox **«diagnóstico: usar el comando literal sin `-vbr off`»** → por defecto
   aplica el comando de producción con `-vbr off` (ADR-02, necesario para cumplir
   ≤ 15 MB en 1 h; ver `RESULT.md` §8). El modo literal es solo comparativa (§5).
5. «Limpiar (unmount + deleteDir + deleteFile)» libera el FS: `unmount` +
   `deleteFile` de la salida + `deleteDir("/output")` **y `deleteDir("/input")`**.

## Automatización (hooks)

- `window.__SPIKE_RESULTS__` — array de objetos JSON con todos los campos por
  ejecución (`fixture`, `inputBytes`, `core`, `encoder`, `ffmpegArgs`, `mountMs`,
  `execMs`, `exitCode`, `outputBytes`, `outputMime`, `outputDurationMs`,
  `peakJsHeapMB`, `peakPageMemoryMB`, `pageBreakdown`, `pageFinalBytes`,
  `pageFinalBreakdown`, `pageFinalError`, `pageSamples`, `pageRejected`,
  `pageFirstError`, `pageSampleIntervalMs`, `logMessages`, `outcome`, `error`, …).
- `#markers` en el DOM — una línea por ejecución:
  `RUN_DONE: <fixture> OK|ERROR exec=<ms>ms mount=<ms>ms out=<bytes>B`
  (sufijo `-cbr` = comando de producción con `-vbr off`; `-vbr` = comando literal
  en modo diagnóstico, p. ej. `large-2gb-cbr`). Es estado runtime:
  se genera al terminar cada ejecución y no sobrevive a una recarga — para evidencia
  persistente usa `__SPIKE_RESULTS__` / `localStorage`.
- `#results` — el mismo JSON volcado en un `<pre>` visible.
- Los resultados se persisten en `localStorage` cada 10 s (una caída de pestaña deja
  un `RUNNING` recuperable como `INTERRUPTED`).

## Estructura

| Archivo | Papel |
|---|---|
| `main.ts` | lógica del spike: carga de cores (R3), montaje WORKERFS, métricas, muestreo de memoria, UI |
| `index.html` | página y controles (un botón por fixture, diagnóstico VBR literal, limpiar, nota de memoria) |
| `vite.config.ts` | headers COOP/COEP/CORP, puerto 5175, copia del core a `public/` |
| `scripts/gen-fixtures.ts` | generación de fixtures con `ffmpeg-static` (CRF corto, CBR forzado en 10 min / 1 h) |
| `package.json`, `bun.lock`, `tsconfig.json` | dependencias y build propios del spike |
| `RESULT.md` | informe completo: entorno, encoders, métricas, veredicto GO/NO-GO (R8) |

## Restricciones respetadas

- Autocontenido en `spikes/workerfs/`: cero cambios en `apps/*`, raíz, `bunfig.toml`,
  `biome.json` o `.moon/`; sin `moon ci`; el spike no se importa desde ninguna app.
- `node_modules/`, `fixtures/`, `dist/`, `public/` y `*.log` **no se commitean**.
- Nunca se llama `writeFile` con el vídeo (R2); el core se sirve desde `public/`
  porque el transform middleware de Vite rompería `ffmpeg-core.js`.
