# RESULT — Spike proxy streaming (CPU) — Task 8

**Veredicto: GO incondicional para el proxy mínimo (`fetch` puro) y GO incondicional
para Elysia 1.4.30 con la ruta `POST /proxy` SIN `body` en el schema.** Ambos hacen
streaming real (primer byte en el sink al 5,3 % / 5,2 % del envío), conservan el hash
SHA-256 byte a byte, propagan 413/500 y miden **0,586 ms / 0,620 ms de CPU p95** con
20 MB, muy por debajo del umbral de 8 ms.

**NO-GO solo para la variante de control `body: t.Any()`**, que consume el stream antes
del handler, devuelve 500 y entrega 0 B al upstream. No es la ruta propuesta: demuestra
la trampa y confirma que la ruta de transcripción **no necesita un Worker dedicado** si
se mantiene sin schema de body.

| Criterio R7 | Umbral GO | Minimal (`fetch` puro) | Elysia sin schema |
|---|---|---|---|
| CPU p95 con 20 MB | **< 8 ms** | **0,586 ms** (1 muestra) | **0,620 ms** (1 muestra) |
| Buffering (20 MB a 2 MB/s) | primer byte < 1/3 del envío | **526 ms de 9 972 ms = 5,3 %** | **523 ms de 9 977 ms = 5,2 %** |
| Integridad del cuerpo | SHA-256 idéntico | **match** (20 000 176 B) | **match** (20 000 176 B) |
| Errores propagados | 413 y 500 llegan | **413 ×3, 500 ×3** | **413 ×3, 500 ×3** |
| Crash / OOM | ninguno | **ninguno** (60 req/config × 3 reps + 50 MB) | **ninguno** |
| Escalado | pendiente en µs/MB | p95 plano < 0,59 ms de 1 a 50 MB | p95 plano < 0,62 ms de 1 a 50 MB |

Margen sobre el umbral: **7,414 ms** (minimal) y **7,380 ms** (Elysia) = 13,7× / 12,9×.
La resolución del sampler es 0,586 ms; los valores por debajo de una muestra se reportan
como 0 y se explican en §3.

---

## 1. Entorno

| Componente | Valor |
|---|---|
| SO | Windows 11 IoT Enterprise LTSC 10.0.26100 (build 26100), x64 |
| CPU | AMD Ryzen 5 9600X — 6 núcleos / 12 hilos |
| RAM | 33 345 003 520 B ≈ 31,1 GiB |
| Bun | 1.3.11 (`C:\Users\IA99\.proto\tools\bun\1.3.11\bun.exe`) |
| Node (host de wrangler) | v24.14.0 |
| `wrangler` | **4.156.0** |
| `workerd` | **2026-10-23** |
| `elysia` | **1.4.30** (`elysia/adapter/cloudflare-worker`) |
| `@cloudflare/workers-types` | **5.20261031.1** |
| `typescript` | **5.9.3** |
| `compatibility_date` | 2025-06-01 |
| Cuenta Cloudflare | **no autenticada**; no se usó dashboard, GraphQL ni deploy |
| Puertos | sink `127.0.0.1:8798`; minimal `8807`/inspector `9240`; elysia `8810`/`9241`; elysia-schema `8812`/`9242` |

Los puertos son dedicados porque los dev servers preexistentes de `apps/web` ocupan
`8787`. El bench **no mata procesos ajenos**: si un puerto está ocupado, aborta con un
error explícito.

---

## 2. Qué se ejecutó

Tres Workers independientes, mismo `src/proxy.ts`, distinto entry:

| ID | Entry | Ruta | Propósito |
|---|---|---|---|
| `minimal` | `src/minimal.ts` | `POST /proxy` → `proxyStream(request)` | línea base sin framework |
| `elysia` | `src/elysia.ts` | `new Elysia({adapter: CloudflareAdapter}).post("/proxy", ({request}) => proxyStream(request)).compile()` | patrón real de `apps/api` **sin** schema de body |
| `elysia-schema` | `src/elysia-schema.ts` | ídem + `{ body: t.Any() }` | control negativo: trampa de buffering |

El upstream es un sink local (`scripts/sink.ts`, Bun) en `127.0.0.1:8798/sink`. **No se
llamó a Groq ni a ningún servicio externo**; no hay claves ni secretos.

Cada configuración válida se ejecutó **20 requests × 3 repeticiones = 60** (excepto
errores: 3; throttle: 3; abort: 1). La matriz completa está en `results/bench.json`
(gitignored) y el log en `results/bench.log`.

---

## 3. Método de medición (qué prueba y qué no)

### 3.1 CPU por request vía CDP

`scripts/measure-cpu.ts` se conecta al inspector de workerd
(`ws://127.0.0.1:<inspector>/ws`, descubierto en `/json/list`) y por **cada request**:

1. `Profiler.enable` + `Profiler.setSamplingInterval(100 µs)`.
2. `Profiler.start` → subida completa (throttle/hash incluidos en el cliente) →
   `Profiler.stop`.
3. Atribuye cada muestra a su `callFrame`; descarta `(idle)` y `(program)`.

**Dos números, publicados por separado:**

- **`cpuEstimateUs` = `nonIdleSamples × intervaloCalibrado`** — el estimador que usan
  las tablas.
- **`cpuUs` = suma de `timeDeltas`** de las muestras no-idle/no-program — el método
  prescrito en R3, conservado por transparencia.

**Por qué las tablas usan el estimador y no la suma de `timeDeltas`:** workerd **solo
emite muestras cuando ejecuta JS**. El intervalo real entre muestras es ~0,586 ms, no
100 µs, y `timeDeltas` mide el hueco de pared entre muestras, incluidos los huecos
idle. Sumarlos atribuye tiempo de espera a JS y produce falsos positivos enormes: con
20 MB, `cpuDeltaUs` da **p95 138,4 ms** (minimal) / **154,3 ms** (Elysia), cuando el
mismo perfil tiene **0–1 muestras no-idle por request**. La estimación por conteo
multiplica esas muestras por el intervalo calibrado y es coherente con la calibración.

**Calibración** (`/burn?ms=200`, 3 corridas por Worker, fuera de las ventanas de
medición):

| Impl | Intervalo | Burn 1 | Burn 2 | Burn 3 |
|---|---:|---:|---:|---:|
| minimal | 585,5 µs/muestra | 246,5 ms | 197,9 ms | 201,4 ms |
| elysia | 590,2 µs/muestra | 248,5 ms | 202,4 ms | 200,7 ms |
| elysia-schema | 587,0 µs/muestra | 246,5 ms | 201,9 ms | 198,4 ms |

La primera corrida sobreestima ~23 % por arranque en frío/JIT; las corridas 2–3
reproducen los 200 ms con error ≤1,2 %. El intervalo se fija con la tanda completa.

**Ruido:** 20 ventanas idle de la duración mediana de la tanda, medidas con el mismo
estimador. **p50 = p95 = máx = 0 en todas las configuraciones**: el ruido está por
debajo de una muestra. El suelo de ruido es, por tanto, **< 0,586 ms**, no un número
distinto de cero.

**CPU de proceso (cota superior, no facturable):** suma de `TotalProcessorTime` de
`wrangler` + `workerd` + `node` descendientes, dividida por request. Incluye el stack
de desarrollo local completo (bundling, dev server, copias de loopback). Sirve para
detectar crecimiento con los bytes, **no** para estimar la factura de Cloudflare.

### 3.2 Buffering

El sink registra **timestamp de llegada de cada chunk** (`performance.now`), bytes
acumulados, `maxGap`, span del cuerpo y SHA-256. El cliente (`scripts/upload.ts`) usa
`node:http`, `Transfer-Encoding: chunked`, escribe por segmentos, aplica throttle
(~2 MB/s) y calcula SHA-256 incremental. Métricas:

- **primer byte en el sink** = `firstChunkAt − firstWriteAt`;
- **span de envío** = último `write` − primer `write`;
- **span del sink** = último chunk − primer chunk;
- **gap máximo** entre chunks;
- **drift** = desviación máxima entre el perfil de bytes enviados y el recibido;
- **hash** enviado vs recibido.

### 3.3 Qué prueba y qué no

**Prueba:** que el handler no materializa el cuerpo (streaming end-to-end con llegada
incremental y hash), que la CPU de JS atribuible al proxy es < 1 muestra en p95 y no
crece de 1 a 50 MB, que los códigos y cabeceras del upstream se propagan, que el abort
del cliente cancela el fetch al upstream, y que Elysia sin schema no consume el stream.

**No prueba:** CPU de producción en hardware de Cloudflare (otro CPU, reutilización de
isolate, TLS/edge), concurrencia multi-tenant, memoria/OOM (no instrumentada; tampoco
se observó OOM), latencia o comportamiento de Groq, ni el modelo de facturación del
plan Free. `wrangler dev` **no aplica** el límite de 10 ms. El GO es una estimación con
margen, no una medición de producción.

**Sobre el contraste en el edge (R3.2):** `wrangler deploy --help` de 4.156.0 **no
expone `--temporary`** (solo `--dry-run`, que no despliega ni mide). No se intentó
ningún despliegue y **no queda nada desplegado**.

---

## 4. Titular: 20 MB multipart, chunks de 1 MB

60 requests por implementación (20 × 3 reps). CPU en µs; `p50 = 0` significa “por
debajo de una muestra”.

| Impl | Status | CPU p50 | CPU p95 | CPU máx | Media | Ruido p95 | Wall p50 | Proc CPU/req | 1er byte | Drift | SHA |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| minimal | 200 ×60 | 0 | **586** | 1 171 | 166 | 0 | 146,4 ms | 96,1 ms | 21 ms | 17,4 % | match |
| elysia | 200 ×60 | 0 | **620** | 1 180 | 236 | 0 | 145,7 ms | 100,8 ms | 19 ms | 20,7 % | match |
| elysia-schema | **500 ×60** | 5 870 | 6 486 | 17 610 | 5 762 | 0 | 87,4 ms | 119,5 ms | — | 100 % | **0 B** |

Lectura: p95 de una sola muestra (586/620 µs). El `wall` incluye al cliente, el sink y
el overhead del profiler; no es CPU. La variante con schema **también estaría por
debajo de 8 ms**, pero falla funcionalmente: el umbral de CPU es necesario, no
suficiente.

---

## 5. Escalado 1 / 5 / 20 / 50 MB

Chunks de 1 MB, multipart, 60 requests por punto. `µs/MB` = media / tamaño; **no es una
pendiente**: está dominada por la cuantización (0 o 1 muestra). La columna que decide
es **p95**, plana.

| Tamaño | Minimal p95 | Minimal media | Minimal µs/MB | Proc ms/req | Elysia p95 | Elysia media | Elysia µs/MB | Proc ms/req |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 MB | 586 | 137 | 136,6 | 16,4 | 590 | 187 | 186,9 | 24,2 |
| 5 MB | 586 | 127 | 25,4 | 50,3 | 590 | 207 | 41,3 | 40,4 |
| 20 MB | 586 | 166 | 8,3 | 96,1 | 620 | 236 | 11,8 | 100,8 |
| 50 MB | 586 | 215 | 4,3 | 182,0 | 590 | 138 | 2,8 | 197,4 |

**Conclusión:** no hay pendiente de CPU JS medible con el sampler: 20 MB y 50 MB cuestan
lo mismo en p95 que 1 MB. El proceso local sí crece (~3,4 ms/MB de 1 a 50 MB), pero es
el stack de desarrollo (bundling + dev server + copias de loopback), no el handler. Un
proxy de streaming puro se comporta como plano, que es la firma esperada.

---

## 6. Tamaño de chunk del cliente (20 MB)

“Writes” = escrituras del cliente (incluye head/tail multipart); el sink lee ~8 KB por
lectura, así que sus ~2 500 chunks no reflejan el tamaño de write del cliente.

| Chunk | Writes | Minimal p95 | Media | µs/chunk | Proc ms | Elysia p95 | Media | µs/chunk | Proc ms |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 64 KB | 307 | 586 | 224 | 0,733 | 93,8 | 590 | 157 | 0,514 | 89,3 |
| 1 MB | 21 | 586 | 166 | 8,295 | 96,1 | 620 | 236 | 11,805 | 100,8 |
| 4 MB | 6 | 615 | 185 | 37,083 | 91,1 | 590 | 138 | 27,544 | 99,7 |

No hay diferencia medible (todo cae en 0–1 muestra). **Recomendación de cliente: 1 MB**
— menos wake-ups que 64 KB, menos memoria pico que 4 MB y el mejor equilibrio para el
throttle realista. La tabla no permite afirmar que 64 KB “cueste más”: a esta resolución
el efecto no es observable.

---

## 7. Prueba de no-buffering (la que decide)

### 7.1 20 MB a 2 MB/s (~10 s), 1 MB/chunk — prueba R4

| Impl | Status | 1er byte | Span envío | Span sink | Último chunk − último write | Gap máx | Drift | Chunks sink | SHA |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| minimal | 200 | **526 ms** | 9 972 ms | 9 447 ms | 1 ms | 542 ms | **5,24 %** | 2 502 | match |
| elysia | 200 | **523 ms** | 9 977 ms | 9 455 ms | 1 ms | 531 ms | **5,24 %** | 2 500 | match |

Primer byte al **5,3 % / 5,2 %** del envío (umbral: < 33 %). Los chunks llegan
repartidos durante ~9,4 s con gaps máximos de ~0,53 s, que es exactamente el ritmo del
throttle (1 MB cada ~0,52 s). Si el proxy bufferease, el sink recibiría todo al final:
primer byte ≈ 10 s, span ≈ 0, drift ≈ 100 %. **No bufferea.**

### 7.2 Control rápido (sin throttle)

| Impl | Status | 1er byte | Span envío | Span sink | Gap máx | Drift | SHA |
|---|---|---:|---:|---:|---:|---:|---|
| minimal | 200 | 21 ms | 16 ms | 123 ms | 10,8 ms | 17,4 % | match |
| elysia | 200 | 19 ms | 15 ms | 123 ms | 13,2 ms | 20,7 % | match |

**Caveat honesto:** en el control rápido el “span de envío” de 16 ms es absorción del
socket del cliente (20 MB en loopback), no el tiempo real de transferencia; por eso el
primer byte (21 ms) puede parecer posterior al último `write`. Este control sirve para
throughput e integridad, **no** para el ratio de primer byte. La prueba válida para R4
es la de 2 MB/s (§7.1). El drift también degenera (99,18 %) cuando el cliente escribe en
un solo chunk; solo es interpretable con ≥3 writes.

**Integridad:** SHA-256 idéntico en todos los casos válidos, incluidos 1/5/20/50 MB,
64 KB/1 MB/4 MB, multipart y octet-stream. Bytes enviados = recibidos = 20 000 176 B
(payload 20 000 000 + envelope multipart de 176 B).

---

## 8. Semántica de la respuesta (R6)

### 8.1 Cabeceras

- **Request:** el proxy elimina hop-by-hop (`connection`, `keep-alive`, `te`,
  `transfer-encoding`, `upgrade`, `host`, **`content-length`**, `expect`, cabeceras
  `cf-*`/`x-forwarded-*`) y añade `x-proxy-spike: 1`. Pasa `method`, headers filtrados,
  `body: request.body` y `signal: request.signal`. No hay `arrayBuffer()`, `text()` ni
  `new Response(request.body)` intermedio.
- **Response:** copia `status`, `statusText` y headers del upstream salvo hop-by-hop y
  `content-encoding`; **re-copia `content-length`** y añade `x-proxy-impl: stream`.
- **Observado en 20 MB:** cliente recibe `200`, `content-type: application/json`,
  `content-length: 101430` (minimal) / `102000` (elysia), más `x-sink` y `x-sink-run`
  del sink. El sink recibe el cuerpo con **`transfer-encoding: chunked` y sin
  `content-length`**: el request no se re-materializa.
- **Matiz 1 MB:** en las pruebas de error (1 MB en una sola escritura) el sink recibió
  `content-length: 1000176`. El proxy **no** lo añade; lo infiere el runtime al tener el
  cuerpo disponible de una vez. No contradice el caso 20 MB, que es el relevante.

### 8.2 413 / 500

| Impl | Caso | Cliente | Echo upstream | `content-length` respuesta | SHA cuerpo | Bytes sink |
|---|---|---|---:|---:|---|---:|
| minimal | 413 | **413** ×3 | 413 | 656 | match | 1 000 176 |
| minimal | 500 | **500** ×3 | 500 | 1 292 | match | 1 000 176 |
| elysia | 413 | **413** ×3 | 413 | 1 321 | match | 1 000 176 |
| elysia | 500 | **500** ×3 | 500 | 2 575 | match | 1 000 176 |

El cliente recibe el código real, no un 200. El cuerpo de error del sink viaja íntegro.

### 8.3 Abort del cliente

Con `abortAfterMs=1500` sobre 20 MB a 2 MB/s: el cliente corta a **3 145 862 B**
(3 MB + head multipart), `status = 0`. El sink Bun **no observa** el cierre del socket
(su run activo queda abierto con 3 145 862 B / 394–400 chunks), por una limitación del
sink, no del proxy. Para verificar la propagación se sustituyó el sink por un upstream
**Node real** (`scripts/sink-node.cjs`, `node:http`), con evidencia fresca:

```
[node-sink] #1 start te=chunked cl=undefined
[node-sink] #1 ABORTED after 3145862 B
[node-sink] #1 CLOSE after 3145862 B complete=false
```

**El abort del cliente sí se propaga al upstream.** (`results/sink-node-abort.log`,
gitignored; el script se commitea como evidencia reproducible.)

---

## 9. Elysia: sin schema vs con schema

| Variante | ¿Consume el body? | 20 MB multipart | 20 MB octet-stream | CPU p50 / p95 |
|---|---|---|---|---|
| **sin `body`** | **no** | 200, 2 520 chunks, 1er byte 523 ms, SHA match | 200, SHA match | 0 / **620 µs** |
| **`body: t.Any()`** | **sí** | **500**, 0 B en sink, 92 B de respuesta | **500**, 0 B en sink, 92 B | 5 870 / 6 486 µs (multipart); 4 696 / 5 283 µs (octet) |

Mensaje exacto del 500 (92 B, `text/plain`), verificado con el bench y con una
reproducción manual:

```
This ReadableStream is disturbed (has already been read from), and cannot be used as a body.
```

Con schema, Elysia activa su parser (`hasBodyInference`) y llama a `request.formData()`
(o al parser equivalente) **antes** del handler; cuando `proxyStream` intenta usar
`request.body`, el stream ya está consumido. El coste en CPU es ~10× el de la ruta
streaming y, aun así, estaría por debajo de 8 ms: **lo que la descarta es la función, no
el CPU**.

**Decisión:** la ruta de transcripción puede quedarse en Elysia **sin `body` en el
schema**. No hace falta un Worker dedicado. Si en el futuro se necesita validación de
schema en esa ruta, hay que moverla a un Worker dedicado o validar después de empezar a
streamear, nunca con `body: t.Any()`.

---

## 10. Limitaciones

1. **Medición local, no de producción.** workerd sobre Ryzen 5 9600X; `wrangler dev`
   **no aplica** el límite de 10 ms ni reproduce el hardware/edge de Cloudflare. El GO
   es una estimación con 13× de margen, no una medición facturable.
2. **Resolución del sampler:** 0,586 ms. `p50 = 0` y `p95 = 586 µs` significan “0 o 1
   muestra”, no “cero absoluto”. El ruido también es 0, así que la señal de 1 muestra
   está por encima del suelo, pero no se puede resolver más fino con este sampler.
3. **CPU de proceso** incluye el stack de desarrollo y no es facturable; solo se usa
   como cota superior y para ver la pendiente.
4. **Sin concurrencia:** las requests son secuenciales. No se prueba multi-tenant,
   límites de isolates ni contención.
5. **Sin memoria instrumentada:** no se midió pico de heap; no se observó OOM ni crash
   en 60 req/config × 3 reps, incluido 50 MB.
6. **Sin Groq/TLS:** upstream local por loopback. No se prueba latencia, TLS, ni el
   comportamiento real de Groq.
7. **Sin contraste en el edge:** `wrangler deploy --temporary` no existe en 4.156.0; no
   se desplegó nada.
8. **Abort:** el sink Bun no ve el cierre del socket; la propagación se demuestra con un
   upstream Node (`sink-node.cjs`), no con el sink del bench.
9. **Drift** no es interpretable con una sola escritura del cliente (99,18 %): se
   reporta solo donde hay ≥3 writes.
10. **El plan Free factura CPU, no “wake-ups” por chunk**; la tabla de chunks mide el
    efecto observable en este entorno, que es nulo a esta resolución.

---

## 11. Reproducción

### 11.1 Matriz completa (recomendado)

```powershell
cd spikes/proxy-cpu
bun install
bun run typecheck          # debe salir 0
bun run bench              # sink + 3 workers + toda la matriz
```

El bench arranca su propio sink (`:8798`) y sus propios `wrangler dev`; comprueba los
puertos antes de arrancar y **no mata procesos ajenos**. Al terminar escribe
`results/bench.json` y `results/bench.log` (gitignored) y para todo.

Variantes:

```powershell
bun run bench -- --only minimal
bun run bench -- --only elysia --configs headline-20mb,throttled-20mb
bun run bench -- --quick          # 5 req × 1 rep, smoke test
```

### 11.2 Medición suelta (sink + dev server + cliente)

```powershell
# terminal A — sink local (NO es Groq)
bun run sink                                  # 127.0.0.1:8798

# terminal B — worker mínimo
bun run dev                                   # 127.0.0.1:8807, inspector 9240
# o: bun run dev:elysia / bun run dev:elysia-schema

# terminal C — subida con throttle + hash
bun run upload -- --url http://127.0.0.1:8807/proxy `
  --size 20 --chunk 1024 --rate 2 --multipart

# o medición CPU por CDP (20 requests)
bun run measure -- --inspector 9240 `
  --url http://127.0.0.1:8807/proxy `
  --size 20 --chunk 1024 --multipart --repeat 20
```

### 11.3 Abort con upstream Node (evidencia de §8.3)

```powershell
node scripts/sink-node.cjs                    # 127.0.0.1:8798
bun run dev                                   # 127.0.0.1:8807
```

```ts
// temp-abort.ts — ejecutar con `bun temp-abort.ts`
import { uploadOnce } from "./scripts/upload";
await uploadOnce({
  url: "http://127.0.0.1:8807/proxy",
  sizeBytes: 20_000_000,
  chunkBytes: 1024 * 1024,
  rateBytesPerSec: 2_000_000,
  multipart: true,
  abortAfterMs: 1500,
});
```

Salida esperada del upstream: `ABORTED after 3145862 B` y
`CLOSE after 3145862 B complete=false`.

### 11.4 Limpieza

```powershell
Remove-Item -Recurse -Force .wrangler   # estado local de workerd
```

Si un `wrangler dev` queda vivo, matar **solo** el PID que escucha en `8807/8810/8812`
o `8798`; no tocar `apps/web` (`8787`).

---

## 12. Conclusión

El proxy de streaming es viable tal cual: **`request.body` → `fetch(upstream, {body})`
sin buffering**, con CPU JS por debajo de una muestra del sampler (0,586 ms p95 con
20 MB) y sin crecimiento de 1 a 50 MB. Elysia 1.4.30 **conserva el streaming si la ruta
no declara `body`**; el patrón de `apps/api` sirve, no hace falta un Worker dedicado.
La única trampa es declarar `body: t.Any()`: consume el stream, devuelve 500 y entrega
0 B. **GO incondicional para minimal y Elysia sin schema; NO-GO para la variante con
schema.**
