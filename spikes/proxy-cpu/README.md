# Spike: proxy streaming de 20 MB (CPU) — Task 8

Spike autocontenido para responder una pregunta: **¿puede `apps/api` reenviar una
subida de audio de 20 MB a Groq sin buffering y con CPU por request dentro del plan Free
de Cloudflare Workers?** El upstream es un sink local; **no se llama a Groq**.

**Veredicto:** GO para el proxy mínimo (`fetch` puro) y GO para Elysia 1.4.30 con la
ruta sin `body` en el schema. NO-GO solo para la variante de control `body: t.Any()`,
que consume el stream y devuelve 500. Detalle, tablas y caveats en [`RESULT.md`](./RESULT.md).

## Quick start

```powershell
cd spikes/proxy-cpu
bun install
bun run typecheck
bun run bench
```

`bun run bench` arranca el sink (`127.0.0.1:8798`) y los tres Workers, ejecuta la matriz
completa (20 requests × 3 reps por configuración) y escribe `results/bench.json` +
`results/bench.log` (gitignored). Al terminar para todo. No mata procesos ajenos.

Smoke test rápido:

```powershell
bun run bench -- --quick
bun run bench -- --only minimal --configs headline-20mb
```

Añadir solo los tamaños de producción / refrescar la memoria sin repetir la matriz:

```powershell
bun run bench -- --only minimal --configs scale-5.4mb,scale-11.9mb --merge
bun run bench -- --only elysia  --configs scale-5.4mb,scale-11.9mb --merge
```

## Estructura

```
src/
  config.ts           UPSTREAM_URL (127.0.0.1:8798/sink)
  proxy.ts            proxy de streaming puro (request.body → fetch)
  minimal.ts          Worker mínimo (fetch puro)
  elysia.ts           Elysia sin body en el schema
  elysia-schema.ts    control negativo: body: t.Any()
  burn.ts             /burn?ms=N para calibrar el profiler
scripts/
  sink.ts             sink Bun: timestamps por chunk, SHA-256, headers
  upload.ts           cliente chunked con throttle, hash incremental y abort
  measure-cpu.ts      cliente CDP + calibración + estadísticas
  bench.ts            orquestador de la matriz
  summarize.ts        deriva results/bench-summary.json (versionado)
  sink-node.cjs       upstream Node para probar la propagación del abort
wrangler.jsonc              minimal  :8807 / inspector 9240
wrangler.elysia.jsonc       elysia   :8810 / inspector 9241
wrangler.elysia-schema.jsonc schema  :8812 / inspector 9242
results/
  bench-summary.json        métricas agregadas versionadas (lo cita RESULT.md)
```

`results/bench.json` y los logs están gitignored: contienen traces por chunk, muestras
de heap y frames. `results/bench-summary.json` se deriva de ahí con
`bun scripts/summarize.ts` (o `bun run summary`) y `bench.ts` lo regenera al final de
cada corrida.

## Comandos

```powershell
bun run sink                 # sink local :8798
bun run dev                  # minimal :8807
bun run dev:elysia           # elysia :8810
bun run dev:elysia-schema    # schema :8812
bun run upload -- --url http://127.0.0.1:8807/proxy --size 20 --chunk 1024 --rate 2 --multipart
bun run measure -- --inspector 9240 --url http://127.0.0.1:8807/proxy --size 20 --chunk 1024 --multipart --repeat 20
bun run bench [-- --only minimal] [--configs headline-20mb,throttled-20mb] [--quick]
bun run summary              # regenera results/bench-summary.json desde bench.json
```

Los puertos son dedicados porque los dev servers de `apps/web` ocupan `8787`.

## Matriz medida

- 20 MB multipart (1 MB/chunk): CPU y buffering.
- Escalado 1 / 5 / 5,4 / 11,9 / 20 / 50 MB (5,4 MB = chunk de 30 min; 11,9 MB = 1 h).
- Chunks de 64 KB / 1 MB / 4 MB.
- 20 MB octet-stream.
- 20 MB a 2 MB/s (~10 s) para probar que no hay buffering.
- Memoria del isolate: `Runtime.getHeapUsage` cada 50 ms durante 20 MB @ 2 MB/s y
  50 MB @ 5 MB/s (+ RSS del árbol de procesos como cota superior).
- Errores 413 / 500 propagados.
- Abort del cliente a los 1,5 s.

## Método en una línea

CPU por request vía CDP (`Profiler.start` → subida → `Profiler.stop`), estimada como
`muestras no-idle × intervalo calibrado` (585,5 µs reales); como p95 = 1 muestra, se
publica la **cota de 2 muestras (≤ 1,17 ms)**, no el paso de cuantización. El ruido se
mide con ventanas idle y es 0. La suma de `timeDeltas` prescrita en el brief se publica
aparte porque sobreestima (workerd solo muestrea cuando ejecuta JS). No-buffering se
demuestra con timestamps de llegada por chunk en el sink + SHA-256 enviado/recibido +
throttle a 2 MB/s, y con el **heap del isolate plano** (Δ ~5 KB con 20 y 50 MB).

## Caveats

- Medición local (`wrangler dev`/workerd) sobre Ryzen 5 9600X: **no** es hardware de
  Cloudflare y **no** aplica el límite de 10 ms. El GO es una estimación con margen.
- El sampler resuelve ~0,586 ms; `p50 = 0` significa “por debajo de una muestra” y la
  cifra publicada es la cota de 2 muestras. El perfil es **solo JS**: no incluye el
  stream pumping nativo, así que es una cota inferior de la CPU facturable.
- Sin concurrencia, sin Groq/TLS. **Heap del isolate medido** (Δ ≤ 13,3 KB con 20/50 MB);
  OOM en Cloudflare real **no verificado** (seguimiento de despliegue).
- `wrangler deploy --temporary` no existe en 4.156.0; no se desplegó nada.
- El sink Bun no ve el cierre del socket; el abort se verifica con `sink-node.cjs`.

## Requisitos

Bun 1.3.11, Node 24 (host de wrangler), `wrangler` 4.156.0, `elysia` 1.4.30,
`typescript` 5.9.3, `@cloudflare/workers-types` 5.20261031.1. Versiones exactas en
`package.json`; lockfile en `bun.lock`.
