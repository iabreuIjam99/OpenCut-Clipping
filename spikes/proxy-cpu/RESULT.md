# RESULT — Spike proxy streaming (CPU) — Task 8

**Veredicto: GO — todos los criterios de R7 medidos y cumplidos — para el proxy mínimo
(`fetch` puro) y para Elysia 1.4.30 con la ruta `POST /proxy` SIN `body` en el schema.**
Ambos hacen streaming real (primer byte en el sink al 5,3 % / 5,2 % del envío), conservan
el hash SHA-256 byte a byte, propagan 413/500, mantienen el **heap del isolate plano**
(Δ pico **5 456 B / 5 624 B** con 20 MB y **5 456 B / 5 624 B** con 50 MB) y consumen
**≤ 2 muestras ≈ ≤ 1,17 ms de CPU p95** con 20 MB (muestras no-idle p50/p95/máx =
0/1/2), muy por debajo del umbral de 8 ms.

**NO-GO solo para la variante de control `body: t.Any()`**, que consume el stream antes
del handler, devuelve 500 y entrega 0 B al upstream. No es la ruta propuesta: demuestra
la trampa y confirma que la ruta de transcripción **no necesita un Worker dedicado** si
se mantiene sin schema de body.

| Criterio R7 | Umbral GO | Minimal (`fetch` puro) | Elysia sin schema | Método |
|---|---|---|---|---|
| CPU p95 con 20 MB | **< 8 ms** | **≤ 2 muestras ≈ ≤ 1,17 ms** (0/1/2) | **≤ 2 muestras ≈ ≤ 1,18 ms** (0/1/2) | conteo de muestras no-idle × intervalo calibrado (§3.1) |
| Buffering (20 MB a 2 MB/s) | primer byte < 1/3 del envío | **526 ms de 9 972 ms = 5,3 %** | **523 ms de 9 977 ms = 5,2 %** | timestamps por chunk del sink (§7.1) |
| Integridad del cuerpo | SHA-256 idéntico | **match** (20 000 176 B) | **match** (20 000 176 B) | SHA-256 cliente vs sink |
| Errores propagados | 413 y 500 llegan | **413 ×3, 500 ×3** | **413 ×3, 500 ×3** | §8.2 |
| **Heap del isolate** (sustituye a “sin OOM”) | Δ pico ≪ tamaño del cuerpo | **Δ 5 456 B** (20 MB) y **5 456 B** (50 MB); `totalSize` 3 670 016 B | **Δ 5 624 B** y **5 624 B**; `totalSize` 5 730 304 B | `Runtime.getHeapUsage` cada 50 ms (§3.4) |
| Sin OOM en Cloudflare real | — | **no verificado** (seguimiento) | **no verificado** (seguimiento) | — |
| Escalado | cota en µs/MB | p95 plano de 1 a 50 MB; 5,4 MB y 11,9 MB ≤ 2 muestras | ídem | §5 |

Margen sobre el umbral: **1,171 ms** (minimal) y **1,180 ms** (Elysia) frente a 8 ms =
**6,8× / 6,8×**; frente al límite de **10 ms** de v1 = **8,5×**. (La ronda 0 calculaba
13,7× restando los 0,586 ms nominales a 8 ms; ese número era cuantización, no medida.
Ver §3.1.1.) El criterio “sin OOM” **se retiró del GO**: no se puede verificar en
`wrangler dev`, y en su lugar queda la prueba medida de heap acotado.

> **Corrección (Fix round 1).** La ronda 0 afirmaba “0,586 ms de CPU p95” y “sin OOM”
> sin medir memoria. Ambas cosas están corregidas arriba: la CPU se reporta como cota de
> 2 muestras y la memoria se midió con el inspector. Los números originales se conservan
> en §4, §5 y §12 y se explican en §3.1.1, §3.1.2 y §13.

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

1. `Profiler.enable` + `Profiler.setSamplingInterval(100 µs)` — **solicitado**; el
   intervalo efectivo de este workerd es ~585,5 µs (§3.1.1).
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

#### 3.1.1 Cuantización: por qué “0,586 ms” no es una medición

`Profiler.setSamplingInterval(100 µs)` **no se aplica** en este workerd: la calibración
con `/burn?ms=200` da un intervalo efectivo de **585,5 µs/muestra** (minimal) y
**590,2 µs/muestra** (Elysia). El profiler además **solo emite muestras cuando ejecuta
JS**: el proxy está idle esperando al cliente y al upstream la mayor parte del tiempo.

Con 20 MB, el p95 es **1 muestra no-idle** y el máximo **2** en 60 requests. Un p95 de
una muestra multiplicado por el intervalo da 585,5 µs, pero ese número es el **paso de
cuantización**, no una medida: el coste real está en algún punto de **[0, 585,5 µs]**.
Como el máximo observado es 2 muestras, la afirmación defendible es:

> **CPU JS por request ≤ 2 muestras ≈ ≤ 1,171 ms** (minimal) / **≤ 1,180 ms** (Elysia).

Esa es la cifra que usan las tablas: `cota = muestras no-idle máx × intervalo`. Los
conteos crudos (`nonIdleSamples.p50/p95/max`) se publican en §4 y §5 para que la cota sea
auditable. **El hallazgo no es que el CPU sea 0,586 ms: es que el CPU está por debajo de
la capacidad de resolución del sampler.** El presupuesto de 8 ms tiene ≥6,8× de holgura
frente a la cota, y ≥8,5× frente a los 10 ms de v1.

No se puede mejorar la resolución subiendo el volumen: una corrida de ~10 s a 585 µs
produce ~17 000 muestras totales, pero solo **1 no-idle** por request; el resto es idle.
Eso confirma que el proxy **genuinamente casi no hace nada**, que es la conclusión útil.

#### 3.1.2 Cota inferior: qué no ve el profiler

El perfil V8 mide **solo JS**. **No** captura el trabajo nativo de workerd: copia de
bytes entre el socket entrante y el `fetch` saliente (stream pumping), backpressure,
framing HTTP/chunked, TLS, ni el coste del propio runtime. En Cloudflare la CPU
facturable incluye ese trabajo del runtime, así que:

- **`cpuEstimateUs` es una cota inferior**, no la CPU facturable;
- el margen de ≥6,8× es sobre la parte JS, y la parte nativa queda **sin medir**;
- aun así el GO es defendible porque el proxy no transforma el cuerpo (no parsea, no
  copia en buffers propios, no reensambla), de modo que el trabajo nativo es el de un
  passthrough de stream, y el margen disponible es amplio. La verificación exacta
  requiere desplegar y leer la CPU facturable en el dashboard, que no se hizo (§10).

#### 3.1.3 Derivados por MB y por chunk

`cpuPerMbUs` (= media / tamaño) y `cpuPerChunkUs` (= media / chunks) **dividen una media
de muestras cuantizadas**, así que **no son costes medidos**: son cotas superiores
derivadas. Por eso el bench añade `cpuPerMbUpperUs` / `cpuPerChunkUpperUs`, calculados
sobre el **p95 de muestras** en lugar de la media. Las tablas de §5 usan esas cotas y
las etiquetan como tales.

### 3.2 Buffering

El sink registra **timestamp de llegada de cada chunk** (`performance.now`), bytes
acumulados, `maxGap`, span del cuerpo y SHA-256. El cliente (`scripts/upload.ts`) usa
`node:http`, `Transfer-Encoding: chunked`, escribe por segmentos, aplica throttle
(~2 MB/s) y calcula SHA-256 incremental. Métricas:

- **primer byte en el sink** = `firstChunkAt − firstWriteAt`;
- **span de envío** = último `write` − primer `write`;
- **span del sink** = último chunk − primer chunk;
- **gap máximo** entre chunks;
- **drift** = `max |F_sink(u) − F_send(u)|` en puntos porcentuales. Se normaliza el eje
  de tiempo de cada lado a [0,1] (envío: primer → último `write`; sink: primer → último
  chunk), se calcula la fracción acumulada de bytes en cada punto `u` del eje del sink y
  se compara con la fracción acumulada del envío interpolada en ese mismo `u`. Un proxy
  que bufferea da ~100 % (todo llega al final); uno que streamea, pocos puntos.
  **Necesita ≥3 writes del cliente:** con una sola escritura todos los puntos del envío
  colapsan en `u = 0` con fracción 1, y la métrica degenera en ~99 % — artefacto de la
  definición, no un fallo del proxy (§7.2);
- **hash** enviado vs recibido.

### 3.3 Qué prueba y qué no

**Prueba:** que el handler no materializa el cuerpo (streaming end-to-end con llegada
incremental y hash), que la CPU de JS atribuible al proxy es ≤ 2 muestras en p95 y no
crece de 1 a 50 MB, que el **heap del isolate no crece con el tamaño del cuerpo**, que
los códigos y cabeceras del upstream se propagan, que el abort del cliente cancela el
fetch al upstream, y que Elysia sin schema no consume el stream.

**No prueba:** CPU de producción en hardware de Cloudflare (otro CPU, reutilización de
isolate, TLS/edge), el trabajo nativo del runtime (§3.1.2), concurrencia multi-tenant,
**OOM en el edge real** (el heap local está acotado, pero eso no es el límite de memoria
de un isolate de producción), latencia o comportamiento de Groq, ni el modelo de
facturación del plan Free. `wrangler dev` **no aplica** el límite de 10 ms. El GO es una
estimación con margen, no una medición de producción.

**Sobre el contraste en el edge (R3.2):** `wrangler deploy --help` de 4.156.0 **no
expone `--temporary`** (solo `--dry-run`, que no despliega ni mide). No se intentó
ningún despliegue y **no queda nada desplegado**.

### 3.4 Memoria del isolate (heap) y RSS

**Expectativa declarada antes de medir:** un proxy que **no** bufferea debe mostrar un
Δ de heap de **pocos MB como máximo** con 20 MB (en la práctica, KB, si solo hay punteros
y buffers del runtime); uno que **bufferee** mostraría **≈ el tamaño del cuerpo**
(≈ 20 MB de Δ). Es la prueba más directa contra el buffering, más fuerte que “no hubo
crash”.

`scripts/measure-cpu.ts#sampleMemoryDuringUpload` usa el mismo inspector CDP:

1. `Runtime.enable` + `Performance.enable` (si el build lo soporta).
2. Lee **`Runtime.getHeapUsage` → `{usedSize, totalSize}`** como línea base.
3. Lanza **una subida dedicada** (no la del perfilado) y muestrea `getHeapUsage` **cada
   50 ms** mientras el cuerpo fluye.
4. Espera **500 ms** de asentamiento y vuelve a leer el heap.
5. Reporta **Δ pico** = `max(usedSize durante y después) − usedSize línea base`, más
   `totalSize` (capacidad del heap) y `peakDeltaBytes` / `afterDeltaBytes`.

Ritmo: **20 MB a 2 MB/s** y **50 MB a 5 MB/s** → ~10 s por medición, para que el
muestreo cubra todo el stream. Se ejecuta para `minimal` y `elysia`, no para el control
negativo ni en `--quick`.

**`Performance.getMetrics` como contraste:** en workerd **2026-10-23**
`Performance.enable` **no está soportado** y `Performance.getMetrics` no devuelve
métricas. Se registra como nota en el resultado; el contraste queda **no disponible** y
no se sustituye por una cifra inventada.

**RSS del árbol de procesos (segunda señal, solo cota):** `WorkingSet64` y
`PeakWorkingSet64` de los **7 procesos** del `wrangler dev` (node → wrangler → workerd →
inspector → dev server), antes y después de la subida. Incluye runtime + isolate +
inspector + dev server, por eso **es una cota superior y ruidosa**, no el heap del
Worker: en una corrida el Δ de RSS con 20 MB salió **negativo** (−13,7 MB), señal de que
el ruido (GC del host, page cache) domina la señal. Sirve para descartar un crecimiento
del orden del cuerpo, nada más.

**Sobre el contraste en el edge (R3.2):** `wrangler deploy --help` de 4.156.0 **no
expone `--temporary`** (solo `--dry-run`, que no despliega ni mide). No se intentó
ningún despliegue y **no queda nada desplegado**.

---

## 4. Titular: 20 MB multipart, chunks de 1 MB

60 requests por implementación (20 × 3 reps). CPU en µs; `p50 = 0` significa “por
debajo de una muestra”.

| Impl | Status | Muestras p50/p95/máx | CPU p50 | CPU p95 | CPU máx (cota) | Media | Ruido p95 | Wall p50 | Proc CPU/req | 1er byte | Drift | SHA |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| minimal | 200 ×60 | **0 / 1 / 2** | 0 | 586 | **1 171** | 166 | 0 | 146,4 ms | 96,1 ms | 21 ms | 17,4 % | match |
| elysia | 200 ×60 | **0 / 1 / 2** | 0 | 620 | **1 180** | 236 | 0 | 145,7 ms | 100,8 ms | 19 ms | 20,7 % | match |
| elysia-schema | **500 ×60** | 10 / 11 / 30 | 5 870 | 6 486 | 17 610 | 5 762 | 0 | 87,4 ms | 119,5 ms | — | 100 % | **0 B** |

Lectura: p95 de **una sola muestra** (586/620 µs nominales) y máximo de **2**. La cifra
defendible es la cota de 2 muestras: **≤ 1,171 ms / ≤ 1,180 ms** (§3.1.1). El `wall`
incluye al cliente, el sink y el overhead del profiler; no es CPU. La variante con schema
**también estaría por debajo de 8 ms**, pero falla funcionalmente: el umbral de CPU es
necesario, no suficiente.

---

## 5. Escalado 1 / 5 / 5,4 / 11,9 / 20 / 50 MB

Chunks de 1 MB, multipart, 60 requests por punto. `µs/MB` **es una cota superior**
derivada de la cuantización (p95 / tamaño), **no una pendiente ni un coste medido**; ver
§3.1.3. La columna que decide es **p95 de muestras**, plano.

**Minimal** (`fetch` puro):

| Tamaño | Muestras p50/p95/máx | Media µs | p95 µs | Cota µs | µs/MB (media, ronda 0) | µs/MB cota† | Proc ms/req |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 MB | 0 / 1 / 1 | 137 | 586 | 586 | 136,6 | 585,5 | 16,4 |
| 5 MB | 0 / 1 / 1 | 127 | 586 | 586 | 25,4 | 117,1 | 50,3 |
| **5,4 MB** (chunk 30 min) | 0 / 1 / 1 | 126 | 581 | **581** | 23,3 | 107,6 | 48,2 |
| **11,9 MB** (1 h) | 0 / 1 / 2 | 194 | 610 | **1 162** | 16,3 | 51,3 | 72,7 |
| 20 MB | 0 / 1 / 2 | 166 | 586 | 1 171 | 8,3 | 29,3 | 96,1 |
| 50 MB (techo) | 0 / 1 / 2 | 215 | 586 | 1 171 | 4,3 | 11,7 | 182,0 |

**Elysia sin schema:**

| Tamaño | Muestras p50/p95/máx | Media µs | p95 µs | Cota µs | µs/MB (media, ronda 0) | µs/MB cota† | Proc ms/req |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 MB | 0 / 1 / 1 | 187 | 590 | 590 | 186,9 | 590,2 | 24,2 |
| 5 MB | 0 / 1 / 1 | 207 | 590 | 590 | 41,3 | 118,0 | 40,4 |
| **5,4 MB** (chunk 30 min) | 0 / 1 / 1 | 165 | 583 | **583** | 30,6 | 108,0 | 52,9 |
| **11,9 MB** (1 h) | 0 / 1 / 2 | 175 | 583 | **1 180** | 14,7 | 49,0 | 77,1 |
| 20 MB | 0 / 1 / 2 | 236 | 620 | 1 180 | 11,8 | 31,0 | 100,8 |
| 50 MB (techo) | 0 / 1 / 2 | 138 | 590 | 1 180 | 2,8 | 11,8 | 197,4 |

† Cota superior = p95 µs / tamaño (derivada de la cuantización, no medida); ver §3.1.3.
La columna “media” es la de la ronda 0 y se conserva para comparar.

**Conclusión:** no hay pendiente de CPU JS medible con el sampler. Los dos tamaños que
importan al producto caen en la misma cota que 1 MB y 20 MB: **5,4 MB (chunk de 30 min)
≤ 1 muestra (bajo la resolución del sampler: < 0,58 ms)** y **11,9 MB (1 h) ≤ 2 muestras
≈ 1,16–1,18 ms**, igual que 50 MB. El proceso local sí crece (~3,4 ms/MB de 1 a 50 MB),
pero es el stack de desarrollo (bundling + dev server + copias de loopback), no el
handler. Un proxy de streaming puro se comporta como plano, que es la firma esperada.

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
es la de 2 MB/s (§7.1).

**El 99,18 % de drift no es un fallo.** En las configuraciones de 1 MB el cliente
escribe el cuerpo en **una sola escritura**; la definición de drift (§3.2) normaliza el
eje del envío entre el primer y el último `write`, que coinciden, así que todos los
puntos de envío caen en `u = 0` con fracción acumulada 1. Cualquier `u > 0` compara 1
contra la fracción del sink (≈0 al principio) → ~99 %. Es un **artefacto de una sola
escritura**, no buffering: el mismo proxy da 5,24 % cuando el envío tiene 21 writes
(§7.1). La métrica solo es interpretable con ≥3 writes; por eso no se usa como criterio
en el titular.

### 7.3 Heap del isolate durante el stream (20 y 50 MB) — prueba de memoria

Expectativa declarada antes de medir (§3.4): no-buffering → Δ de pocos MB como máximo
(en la práctica, KB); buffering → Δ ≈ tamaño del cuerpo. Resultado (una subida dedicada
por tamaño, heap muestreado cada 50 ms, 500 ms de asentamiento; `Runtime.getHeapUsage`):

| Impl | Tamaño | Ritmo | Muestras | `usedSize` base | Pico | Después | **Δ pico** | Δ después | `totalSize` |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| minimal | 20 MB | 2 MB/s | 158 | 1 077 600 B | 1 083 056 B | 1 083 056 B | **5 456 B** | 5 456 B | 3 670 016 B |
| minimal | 50 MB | 5 MB/s | 159 | 1 083 056 B | 1 088 512 B | 1 088 512 B | **5 456 B** | 5 456 B | 3 670 016 B |
| elysia | 20 MB | 2 MB/s | 158 | 3 643 012 B | 3 648 636 B | 3 648 636 B | **5 624 B** | 5 624 B | 5 730 304 B |
| elysia | 50 MB | 5 MB/s | 159 | 3 648 636 B | 3 654 260 B | 3 654 260 B | **5 624 B** | 5 624 B | 5 730 304 B |

**Comparación con la expectativa:** el Δ pico es **~3 700× menor** que el cuerpo de
20 MB y **~9 200× menor** que el de 50 MB; un proxy que bufferease habría mostrado un Δ
del orden de 20–50 MB (≈ 0,03 % del cuerpo con 20 MB y ~0,01 % con 50 MB, frente a
~100 % si bufferease). El heap **no crece con el tamaño**: 20 MB y 50 MB dan el mismo Δ. En una corrida previa de la misma build, minimal
dio **5 440 B** (20 MB) y **13 308 B** (50 MB); el rango entre corridas es
**5,4–13,3 KB**, siempre KB. `totalSize` es constante (3,5 MiB / 5,5 MiB), es decir, el
runtime **no tuvo que expandir el heap**.

Esto es la evidencia más fuerte contra el buffering: no solo el cuerpo llega
incrementalmente (§7.1), sino que el isolate **no retiene el cuerpo**.

**RSS del árbol de procesos (cota, no medida del isolate):**

| Impl | Tamaño | WorkingSet antes → después | Δ | PeakWorkingSet antes → después |
|---|---:|---|---:|---|
| minimal | 20 MB | 496 320 512 → 511 541 248 B | +15,2 MB | 591 462 400 → 602 767 360 B |
| minimal | 50 MB | 511 541 248 → 520 507 392 B | +9,0 MB | 602 767 360 → 613 011 456 B |
| elysia | 20 MB | 551 378 944 → 566 439 936 B | +15,1 MB | 714 985 472 → 725 835 776 B |
| elysia | 50 MB | 566 439 936 → 582 799 360 B | +16,4 MB | 725 835 776 → 740 458 496 B |

Son **7 procesos** (node → wrangler → workerd → inspector → dev server) y el RSS
acumula el estado del dev server entre mediciones. **No es proporcional al cuerpo**
(con 50 MB crece menos que con 20 MB en minimal) y en una corrida previa el Δ con 20 MB
salió **negativo** (−13,7 MB): el ruido del host domina. Sirve para descartar un
crecimiento del orden del cuerpo, **no** para afirmar cuánta memoria usa el isolate. La
cifra que decide es la de heap.

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
   es una estimación con **≥6,8× de margen sobre la cota de CPU JS**, no una medición
   facturable.
2. **Resolución del sampler:** 585,5 / 590,2 µs por muestra. `p50 = 0` y `p95 = 1
   muestra` significan “0 o 1 muestra”, no “cero absoluto”; la cifra publicada es la
   **cota de 2 muestras** (§3.1.1). El ruido también es 0, así que la señal de 1 muestra
   está por encima del suelo, pero no se puede resolver más fino con este sampler.
3. **CPU de proceso** incluye el stack de desarrollo y no es facturable; solo se usa
   como cota superior y para ver la pendiente.
4. **Sin concurrencia:** las requests son secuenciales. No se prueba multi-tenant,
   límites de isolates ni contención.
5. **Memoria:** el **heap del isolate sí se midió** (§7.3: Δ 5,4–13,3 KB con 20 y
   50 MB, `totalSize` constante). **No** se midió el límite de memoria de un isolate
   real ni se verificó ausencia de OOM en Cloudflare: `Performance.getMetrics` no está
   soportado en este workerd, el RSS es una cota ruidosa y el edge no se probó. **“Sin
   OOM” no forma parte del GO**: es un seguimiento de despliegue.
6. **Sin Groq/TLS:** upstream local por loopback. No se prueba latencia, TLS, ni el
   comportamiento real de Groq.
7. **Sin contraste en el edge:** `wrangler deploy --temporary` no existe en 4.156.0; no
   se desplegó nada.
8. **Abort:** el sink Bun no ve el cierre del socket; la propagación se demuestra con un
   upstream Node (`sink-node.cjs`), no con el sink del bench.
9. **Drift** no es interpretable con una sola escritura del cliente (99,18 %): es un
   artefacto de la definición (§3.2, §7.2); se reporta solo donde hay ≥3 writes.
10. **El plan Free factura CPU, no “wake-ups” por chunk**; la tabla de chunks mide el
    efecto observable en este entorno, que es nulo a esta resolución.
11. **CPU facturable ≠ CPU JS medida:** el profiler V8 no ve el stream pumping nativo de
    workerd (§3.1.2); la cifra es una **cota inferior**.

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

**Evidencia versionada:** las métricas agregadas que cita este documento están en
[`results/bench-summary.json`](./results/bench-summary.json) (statuses, conteos de
muestras, heap `usedSize` baseline/pico/Δ, bytes, SHA, primer/último byte, drift y
calibración). Lo genera `scripts/summarize.ts` desde `results/bench.json` —gitignored
porque contiene traces por chunk, muestras y frames— y `bench.ts` lo reescribe solo al
final de cada corrida. Regenerar sin repetir la matriz: `bun run summary`.

Variantes:

```powershell
bun run bench -- --only minimal
bun run bench -- --only elysia --configs headline-20mb,throttled-20mb
bun run bench -- --quick          # 5 req × 1 rep, smoke test
```

**Tamaños de producción (5,4 MB = chunk de 30 min; 11,9 MB = 1 h) y memoria**, sin
repetir la matriz completa (`--merge` conserva los resultados previos y solo reemplaza
las configuraciones corridas + la memoria):

```powershell
bun run bench -- --only minimal --configs scale-5.4mb,scale-11.9mb --merge
bun run bench -- --only elysia  --configs scale-5.4mb,scale-11.9mb --merge
```

La sonda de memoria (`mem-20mb`, `mem-50mb`) se ejecuta automáticamente en cada corrida
no-`--quick` de `minimal` y `elysia`: sube 20 MB a 2 MB/s y 50 MB a 5 MB/s, muestrea
`Runtime.getHeapUsage` cada 50 ms y escribe `impl.memory[]` en `results/bench.json`
(`peakDeltaBytes`, `baseline`/`peak`/`after`, `sampleCount`, `processRss`).

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
sin buffering**, con **CPU JS ≤ 2 muestras ≈ ≤ 1,17 ms** con 20 MB (muestras no-idle
p50/p95/máx = 0/1/2; la ronda 0 reportaba “0,586 ms p95”, que era el paso de
cuantización) y **sin crecimiento medible de 1 a 50 MB**. El **heap del isolate se
mantiene plano**: Δ pico 5 456 B / 5 624 B con 20 y 50 MB, con `totalSize` constante, es
decir, el isolate no retiene el cuerpo. Elysia 1.4.30 **conserva el streaming si la ruta
no declara `body`**; el patrón de `apps/api` sirve, no hace falta un Worker dedicado.
La única trampa es declarar `body: t.Any()`: consume el stream, devuelve 500 y entrega
0 B. **GO para minimal y Elysia sin schema — todos los criterios de R7 medidos y
cumplidos; NO-GO para la variante con schema.**

Dos matices que el GO asume explícitamente: el CPU medido es **solo JS** (cota
inferior; el stream pumping nativo no está en el perfil) y **la ausencia de OOM en
Cloudflare no está verificada**: lo medido es heap acotado en workerd local. El margen
de ≥6,8× sobre 8 ms es lo que hace defendible el GO con esas dos incógnitas.

---

## 13. Fix round 1 — correcciones de la revisión

Esta sección documenta la revisión y **no reescribe** la ronda 0: los números originales
siguen visibles en §4 (p95/media), §5 (columna “µs/MB (media, ronda 0)”) y §12.

### 13.1 C1 — “sin OOM” no estaba medido (crítico)

| Antes (ronda 0) | Ahora |
|---|---|
| “Crash / OOM: ninguno (60 req × 3 reps + 50 MB)”, sin instrumentación | **Heap del isolate medido** con `Runtime.getHeapUsage` antes/durante/después; “sin OOM” **retirado** del GO y marcado como seguimiento en Cloudflare real |

**Expectativa declarada antes de medir:** no-buffering → Δ de pocos MB como máximo con
20 MB; buffering → Δ ≈ tamaño del cuerpo.

**Resultado (Δ pico de `usedSize`):**

| Impl | 20 MB | 50 MB | `totalSize` | Muestras |
|---|---:|---:|---:|---:|
| minimal | **5 456 B** | **5 456 B** | 3 670 016 B | 158 / 159 |
| elysia | **5 624 B** | **5 624 B** | 5 730 304 B | 158 / 159 |

Rango entre corridas (2 corridas, misma build): **5 440–13 308 B**, siempre KB. El Δ es
~3 700× menor que el cuerpo de 20 MB y ~9 200× menor que el de 50 MB, y **no crece con
el tamaño**. Detalle, RSS y método en §3.4 y §7.3.

**Método:** una subida dedicada por tamaño (20 MB @ 2 MB/s, 50 MB @ 5 MB/s), muestreo de
`Runtime.getHeapUsage` cada 50 ms, 500 ms de asentamiento y lectura final;
`Performance.enable`/`getMetrics` **no soportado** en workerd 2026-10-23 (documentado,
sin sustituirlo por una cifra); RSS del árbol de 7 procesos como cota superior ruidosa.

**Efecto en el veredicto:** el GO se mantiene, pero ahora **cada criterio
R7 apunta a un número medido y a su método** (tabla del encabezado). La afirmación “sin
OOM” **ya no se hace**: en su lugar está “heap acotado, sin buffering”, y el OOM en el
edge real queda como **seguimiento de despliegue**.

### 13.2 I1 — el titular de CPU era una sola muestra

`setSamplingInterval(100 µs)` no se aplica: el intervalo efectivo es **585,5 µs**
(minimal) / **590,2 µs** (Elysia). Con p95 = **1 muestra** y máx = **2**, “0,586 ms” era
el paso de cuantización. El titular pasa a:

- **≤ 2 muestras ≈ ≤ 1,171 ms** (minimal) y **≤ 1,180 ms** (Elysia);
- conteos crudos publicados: `nonIdleSamples.p50/p95/max = 0/1/2`;
- márgenes: **6,8×** frente a 8 ms y **8,5×** frente a 10 ms (el “13,7×” de la ronda 0
  se retira: restaba una cifra nominal).

**El hallazgo es el conteo bajo**: el proxy está por debajo de la resolución del
sampler. Subir el volumen no ayuda (una corrida de ~10 s da ~17 000 muestras totales y
~1 no-idle por request): el proxy genuinamente casi no hace nada. Ver §3.1.1.

### 13.3 I2 — atribución: el profiler no ve el runtime

El perfil V8 mide **solo JS**; no captura el stream pumping nativo de workerd,
backpressure, framing HTTP ni TLS. La cifra es una **cota inferior**, no la CPU
facturable. El GO se apoya en que el proxy es un passthrough sin transformación y en el
margen ≥6,8×, no en que “CPU medida = CPU facturada”. Ver §3.1.2.

### 13.4 I3 — tamaños de producción

Añadidas las configuraciones `scale-5.4mb` y `scale-11.9mb` (se conserva `scale-5mb`
por continuidad) y las filas correspondientes en §5:

| Tamaño | Minimal muestras | Minimal cota | Elysia muestras | Elysia cota |
|---:|---|---:|---|---:|
| **5,4 MB** (chunk 30 min) | 0 / 1 / 1 | **581 µs** | 0 / 1 / 1 | **583 µs** |
| **11,9 MB** (1 h) | 0 / 1 / 2 | **1 162 µs** | 0 / 1 / 2 | **1 180 µs** |

Ambos caen en la misma cota que 1 MB y 20 MB; 50 MB se mantiene como techo.

### 13.5 Menores

- **Drift definido** como `max |F_sink(u) − F_send(u)|` con ambos ejes normalizados a
  [0,1] (§3.2) y explicado el **99,18 %** como artefacto de una sola escritura: todos los
  puntos del envío colapsan en `u = 0` con fracción 1 (§7.2). No es un fallo; el mismo
  proxy da 5,24 % con 21 writes.
- **`cpuPerMbUs` / `cpuPerChunkUs` etiquetados como cotas superiores** derivadas de
  cuantización (§3.1.3) y añadidos `cpuPerMbUpperUs` / `cpuPerChunkUpperUs` calculados
  sobre el p95 de muestras; las tablas de §5 usan la cota y conservan la columna media
  original.

### 13.6 Cambios de código y comandos

- `scripts/measure-cpu.ts`: `sampleMemoryDuringUpload` (`Runtime.getHeapUsage` cada
  50 ms, `Performance.getMetrics` como contraste opcional, lectura final tras
  asentamiento).
- `scripts/bench.ts`: sonda de memoria por implementación (`runMemoryProbe`), RSS del
  árbol de procesos, configs `scale-5.4mb`/`scale-11.9mb`, `cpuPerMbUpperUs` /
  `cpuPerChunkUpperUs`, y `--merge` para añadir configuraciones sin repetir la matriz.
- Sin dependencias nuevas, sin secretos, sin Groq, sin despliegue.

```powershell
bun run bench -- --only minimal --configs scale-5.4mb,scale-11.9mb --merge
bun run bench -- --only elysia  --configs scale-5.4mb,scale-11.9mb --merge
bun run typecheck   # exit 0
```

### 13.7 Veredicto tras la corrección

**GO para minimal y Elysia sin schema — todos los criterios de R7 medidos y cumplidos**:
CPU ≤ 2 muestras (≤ 1,17 ms, margen 6,8× sobre 8 ms), no-buffering (primer byte 5,3 %),
integridad SHA, errores propagados y **heap acotado (Δ ≤ 13,3 KB con 20 y 50 MB)**.
**NO-GO para `body: t.Any()`**. **“Sin OOM” ya no es un criterio del GO**: queda como
verificación pendiente en un despliegue real.
