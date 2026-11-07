# MonetizaClip — Plan de implementación (v3, local-first)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Ubicación:** raíz del repo, no `docs/`, porque `.gitignore` excluye `docs/`.

**Goal:** Convertir el rewrite de OpenCut en un generador de clips con coste marginal $0, extrayendo audio en el navegador y transcribiendo en local por defecto, con la nube como acelerador opcional.

**Architecture:** El vídeo nunca se sube. `ffmpeg.wasm` monta el fichero con WORKERFS, extrae audio de 11 MB/h y lo transcribe Whisper en WebGPU dentro de un Web Worker. Un validador puro y determinista convierte la salida del agente en cortes seguros. El modo nube (BYOK + Groq) es opt-in y se degrada a local.

**Tech Stack:** TanStack Start + React 19 + Vite 8 · Elysia en Cloudflare Workers · `@ffmpeg/ffmpeg` (WORKERFS) · `@huggingface/transformers` (Whisper WebGPU) · Zod · Vitest · Cucumber/Playwright-BDD · Biome · moon/proto/bun.

**Spec:** `ARCHITECTURE.md`

---

## Global Constraints

- **BDD obligatorio** (Regla 1 de `agent.md`): toda feature nueva tiene su `.feature` en Gherkin antes de la implementación.
- **Cobertura** (Regla 2): 80 % global (líneas, ramas, funciones, statements); **100 %** en `cut-validator.ts`, `config/env.ts` y `contracts.ts`.
- **Sin `any`** (Regla 3): Biome `noExplicitAny: error` y `tsc --noEmit` limpio. Cero warnings.
- **Validación previa** (Regla 4): explicar impacto y pedir confirmación antes de instalar dependencias o ejecutar comandos destructivos.
- **Secretos** solo en Worker Secrets; prohibido el prefijo `VITE_*` para claves.
- **Validación de media**: tipo por magic bytes + tamaño + duración antes de procesar.
- **Sanitización**: transcript, títulos y salida del LLM se renderizan como texto.
- **Errores**: código genérico + `correlationId` al usuario; detalle solo en logs.
- **Dependencias**: cualquier cambio en `package.json` exige `bun audit` sin vulnerabilidades altas/críticas.
- **Plataforma**: Workers Free = 100 000 req/día, 10 ms CPU, 128 MB, body 100 MB. Nada de Containers, Queues ni R2 obligatorio.
- **Límites de producto**: 4 GB / 3 h por vídeo; móvil fuera del MVP; máximo 20 cortes.

---

## Review Focus

Las cinco entradas que más probablemente rompan el producto y que no cubre ningún requisito explícito:

1. **Vídeo sin pista de audio** → debe fallar rápido con `NO_AUDIO_TRACK`, no colgarse ni producir un audio vacío.
2. **Fichero de 2 GB en móvil o Safari** → rechazo limpio (`UNSUPPORTED_DEVICE` / `FILE_TOO_LARGE`), sin crash de pestaña.
3. **Audio en la frontera de 25 MB o de un chunk** → cero palabras duplicadas y cero perdidas en la costura.
4. **429 del proveedor a mitad de job** → degradación a local conservando el progreso y sin perder el trabajo.
5. **Transcript con `<script>` o instrucciones inyectadas** → se trata como texto, nunca como HTML ni como orden.

Cada una tiene su test en la tarea que posee el código (indicado abajo).

---

## Mapa de ficheros

```
biome.json                                  (nuevo)
vitest.workspace.ts                         (nuevo)
.github/workflows/security.yml              (nuevo)
apps/web/package.json                       (modificar: scripts, deps)
apps/web/vitest.config.ts                   (nuevo)
apps/web/src/routes/editor.tsx              (modificar: client-only)
apps/web/src/routes/__root.tsx              (modificar: devtools solo en DEV)
apps/web/src/lib/clipping/
  media-guard.ts                            (nuevo)
  extract-audio.ts                          (nuevo)
  extract-audio.test.ts                     (nuevo)
  chunk-audio.ts                            (nuevo)
  chunk-audio.test.ts                       (nuevo)
  transcribe.worker.ts                      (nuevo)
  transcribe-local.ts                       (nuevo)
  transcribe-local.test.ts                  (nuevo)
  local-cuts.ts                             (nuevo)
  local-cuts.test.ts                        (nuevo)
  clip-export.ts                            (nuevo)
  use-clipping-job.ts                       (nuevo)
  byok.ts                                   (nuevo)
apps/api/package.json                       (modificar: deps, scripts)
apps/api/vitest.config.ts                   (nuevo)
apps/api/src/config/env.ts                  (nuevo)
apps/api/src/modules/clipping/
  contracts.ts                              (nuevo)
  cut-validator.ts                          (nuevo)
  cut-validator.test.ts                     (nuevo)
  quota.ts                                  (nuevo)
  transcribe.route.ts                       (nuevo)
  transcribe.route.test.ts                  (nuevo)
  analyze.route.ts                          (nuevo)
  analyze.route.test.ts                     (nuevo)
  providers/groq.ts                         (nuevo)
  providers/workers-ai.ts                   (nuevo)
apps/api/src/index.ts                       (modificar: montar rutas)
features/*.feature                          (nuevos)
spikes/workerfs/                            (desechable)
spikes/whisper-webgpu/                      (desechable)
spikes/proxy-cpu/                           (desechable)
```

---

# Fase 0 — Bloqueantes de higiene

> Sin esta fase no hay CI, ni auditoría, ni forma de demostrar nada. **Requiere aprobación explícita** (Regla 4) por las instalaciones.

### Task 1: Repo reproducible

**Files:**
- Create: `apps/web/bun.lock`, `apps/api/bun.lock`, `.git/`
- Modify: `.gitignore` (verificar que cubre `.env*` y `node_modules/`)

**Interfaces:**
- Produces: build reproducible; `bun audit` ejecutable.

- [ ] **Step 1: Inicializar historial**

```powershell
git init
git add -A
git commit -m "chore: baseline del fork antes de la Fase 0"
```

- [ ] **Step 2: Instalar toolchain pineada**

```powershell
proto use
```
Expected: bun 1.3.11 y rust 1.97.0 disponibles.

- [ ] **Step 3: Generar lockfiles**

```powershell
cd apps/web; bun install
cd ../api; bun install
```
Expected: `bun.lock` en ambas apps.

- [ ] **Step 4: Auditar**

```powershell
cd apps/web; bun audit --audit-level=high
cd ../api; bun audit --audit-level=high
```
Expected: 0 vulnerabilidades altas o críticas. Si hay alguna, **detenerse y reportar** (Regla 17 de `agent.md`).

- [ ] **Step 5: Commit**

```powershell
git add apps/web/bun.lock apps/api/bun.lock
git commit -m "chore: lockfiles y auditoría de dependencias"
```

**Aceptación:** `bun audit` limpio y `moon ci` en verde.

---

### Task 2: Lint y tipado estricto

**Files:**
- Create: `biome.json`
- Modify: `apps/web/package.json`, `apps/api/package.json`, `moon.yml`

**Interfaces:**
- Produces: `bun run lint`, `bun run typecheck`.

- [ ] **Step 1: Crear `biome.json`**

Reglas mínimas: `linter.enabled`, `formatter.enabled`, `noExplicitAny: error`, `noUnusedVariables: error`, `noConsole: warn` (permitido en scripts), `useConst: error`.

- [ ] **Step 2: Añadir scripts y tareas de moon**

En ambas apps: `"lint": "biome check ."`, `"typecheck": "tsc --noEmit"`, `"format": "biome format --write ."`. Registrar `lint` y `typecheck` como tareas en `apps/web/moon.yml` y `apps/api/moon.yml`.

- [ ] **Step 3: Verificar que falla con `any`**

Añadir temporalmente `const x: any = 1;` en un fichero y ejecutar `bun run lint`.
Expected: exit code ≠ 0 con `noExplicitAny`.

- [ ] **Step 4: Verificar en limpio**

```powershell
cd apps/web; bun run lint; bun run typecheck
cd ../api; bun run lint; bun run typecheck
```
Expected: exit 0, cero warnings.

- [ ] **Step 5: Commit**

```powershell
git commit -am "chore: biome, tipado estricto y scripts de lint"
```

---

### Task 3: Harness de tests y cobertura

**Files:**
- Create: `apps/api/vitest.config.ts`, `apps/web/vitest.config.ts`, `vitest.workspace.ts`
- Modify: `apps/api/package.json` (script `test`)

**Interfaces:**
- Produces: `moon run api:test`, `moon run web:test`; reporte de cobertura.

- [ ] **Step 1: Configurar Vitest (api)**

`environment: "node"`, `coverage.provider: "v8"`, umbrales `80/80/80/80` globales y `100` para `modules/clipping/cut-validator.ts`, `config/env.ts`, `modules/clipping/contracts.ts`. Si Vitest 4 no soporta `workspace`, usar `test.projects`.

- [ ] **Step 2: Configurar Vitest (web)**

`environment: "jsdom"` (ya existe `jsdom` en devDependencies), `setupFiles` con `@testing-library/jest-dom` si hace falta.

- [ ] **Step 3: Probar el gate**

Crear un test trivial que pase y otro que falle a propósito; ejecutar y verificar que el segundo rompe el comando.

- [ ] **Step 4: Verificar en verde**

```powershell
moon run api:test
moon run web:test
```
Expected: ambos en verde con umbrales aplicados.

- [ ] **Step 5: Commit**

```powershell
git add apps/api/vitest.config.ts apps/web/vitest.config.ts vitest.workspace.ts
git commit -m "test: harness de vitest con umbrales de cobertura"
```

---

### Task 4: Pipeline de seguridad en CI

**Files:**
- Create: `.github/workflows/security.yml`

**Interfaces:**
- Produces: checks `secrets`, `sast`, `deps`.

- [ ] **Step 1: Añadir jobs**

`gitleaks` (con `--redact --exit-code 1`), `semgrep --config p/owasp-top-ten --config p/typescript`, `osv-scanner scan source -r .`, `bun audit --audit-level=high`.

- [ ] **Step 2: Probar con un secreto plantado**

Crear una rama con `const KEY = "sk-test-1234567890";` y abrir PR.
Expected: el job `secrets` falla.

- [ ] **Step 3: Probar el guard de `VITE_`**

Añadir `VITE_OPENAI_KEY=x` y verificar que el pipeline falla (grep explícito en el workflow).

- [ ] **Step 4: Revertir y verificar en verde**

- [ ] **Step 5: Commit**

```powershell
git add .github/workflows/security.yml
git commit -m "ci: gitleaks, semgrep, osv-scanner y bun audit"
```

---

### Task 5: CSP y editor client-only

**Files:**
- Modify: `apps/web/src/routes/editor.tsx`, `apps/web/src/routes/__root.tsx`
- Create: `apps/web/src/lib/security-headers.ts` (o el punto de entrada del Worker)

**Interfaces:**
- Produces: `Content-Security-Policy` en todas las respuestas HTML; editor sin SSR.

- [ ] **Step 1: Marcar el editor como client-only**

Según la API de TanStack Start (`ssr: false` en las opciones de la ruta, o carga diferida con `useEffect`). Si la ruta no lo soporta, envolver el contenido en un componente que solo se monte en cliente.

- [ ] **Step 2: Añadir CSP**

`default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`.

- [ ] **Step 3: Gate de devtools**

Envolver `<TanStackDevtools>` en `import.meta.env.DEV` y mover `@tanstack/react-devtools` a `devDependencies`.

- [ ] **Step 4: Verificar**

```powershell
cd apps/web; bun run build
```
Expected: el HTML del editor no contiene el contenido del editor renderizado en servidor; la respuesta incluye CSP.

- [ ] **Step 5: Commit**

```powershell
git commit -am "fix: CSP, devtools solo en dev y editor client-only"
```

---

# Fase 1 — Spikes Go/No-Go (desechables)

> Código en `spikes/`, no se importa desde producción. **No avanzar a la Fase 2 sin los tres GO.**

### Task 6: Spike WORKERFS + códec

**Files:** Create `spikes/workerfs/index.html`, `spikes/workerfs/main.ts`, `spikes/workerfs/README.md`

**Interfaces:**
- Produces: informe `spikes/workerfs/RESULT.md` con GO/NO-GO y métricas.

- [ ] **Step 1: Montar el fichero con WORKERFS** (nunca `writeFile`).
- [ ] **Step 2: Extraer audio** con `-ac 1 -ar 16000 -c:a libopus -b:a 24k -f webm`.
- [ ] **Step 3: Probar con 500 MB, 2 GB y un fichero de 1 h.**
- [ ] **Step 4: Medir** tiempo total, memoria pico y tamaño de salida; verificar que `libopus` existe. Si no, repetir con `libmp3lame -b:a 32k`.
- [ ] **Step 5: Escribir `RESULT.md`.**

**Aceptación (GO):** 2 GB funciona en Chrome de escritorio; 1 h se extrae en < 3 min; salida ≤ 15 MB; sin OOM. **NO-GO** → cambiar a WebCodecs + `webm-muxer` antes de continuar.

---

### Task 7: Spike Whisper WebGPU

**Files:** Create `spikes/whisper-webgpu/` con el mismo patrón.

- [ ] **Step 1: Cargar `onnx-community/whisper-base` con `device: "webgpu"` y fallback `wasm`.**
- [ ] **Step 2: Transcribir 10 min de audio de 16 kHz con `return_timestamps: "word"`.**
- [ ] **Step 3: Medir** tiempo, memoria y calidad (comparar 20 frases a mano).
- [ ] **Step 4: Verificar** que el modelo se cachea y la segunda carga es < 2 s.
- [ ] **Step 5: Escribir `RESULT.md`.**

**Aceptación (GO):** 10 min en < 3 min en GPU media; timestamps por palabra; WER aceptable; caché funcional.

---

### Task 8: Spike del proxy streaming (CPU)

**Files:** Create `spikes/proxy-cpu/` (Worker mínimo + script de subida).

- [ ] **Step 1: Implementar un handler que pipee `request.body` a un destino HTTP sin parsear.**
- [ ] **Step 2: Subir 20 MB en multipart.**
- [ ] **Step 3: Medir CPU** en `wrangler dev`/dashboard y confirmar que no hay buffering.
- [ ] **Step 4: Probar con Elysia** (ruta sin schema `body`) y, si consume el body, mover la ruta a un Worker dedicado.
- [ ] **Step 5: Escribir `RESULT.md`.**

**Aceptación (GO):** < 8 ms de CPU, sin OOM, respuesta correcta.

---

# Fase 2 — Ingesta y extracción local

### Task 9: Guard de media

**Files:** Create `apps/web/src/lib/clipping/media-guard.ts`, `media-guard.test.ts`, `features/ingesta.feature`

**Interfaces:**
- `validateMediaFile(file: File): Promise<MediaInfo>` con `MediaInfo = { durationMs: number; hasAudio: boolean; container: "mp4" | "webm" | "mkv" | "unknown" }`.
- Errores: `UNSUPPORTED_MEDIA`, `FILE_TOO_LARGE`, `DURATION_EXCEEDED`, `NO_AUDIO_TRACK`, `UNSUPPORTED_DEVICE`.

- [ ] **Step 1: Escribir los escenarios Gherkin** (rechazo por MIME falsificado, por tamaño, por ausencia de audio, por móvil).
- [ ] **Step 2: Escribir el test de `NO_AUDIO_TRACK`** con un fixture sin pista de audio.
- [ ] **Step 3: Implementar** la validación por magic bytes y la comprobación de pista de audio (vía `HTMLMediaElement` o `ffprobe` del spike).
- [ ] **Step 4: Ejecutar** `moon run web:test`. Expected: PASS.
- [ ] **Step 5: Commit.**

**Review Focus #1 y #2** cubiertos aquí.

---

### Task 10: `extractAudio`

**Files:** Create `extract-audio.ts`, `extract-audio.test.ts`

**Interfaces:**
- `extractAudio(file: File, opts: { onProgress?: (p: number) => void; signal?: AbortSignal }): Promise<{ blob: Blob; durationMs: number; codec: "opus" | "mp3" }>`.

- [ ] **Step 1: Test de unidad** con un fixture de 5 s: assert de `blob.type`, tamaño > 0 y `durationMs` dentro de ±200 ms.
- [ ] **Step 2: Implementar** con `mount("WORKERFS")`, `exec` y limpieza garantizada (`try/finally`).
- [ ] **Step 3: Test de cancelación**: `AbortSignal` abortado → rechaza con `AbortedError` y libera el worker.
- [ ] **Step 4: Ejecutar** los tests.
- [ ] **Step 5: Commit.**

---

### Task 11: Segmentación

**Files:** Create `chunk-audio.ts`, `chunk-audio.test.ts`

**Interfaces:**
- Define aquí el tipo compartido: `TranscriptSegment = { startMs: number; endMs: number; text: string }`.
- `chunkAudio(blob: Blob, opts: { maxBytes: number; overlapMs: number }): Promise<AudioChunk[]>` con `AudioChunk = { blob: Blob; offsetMs: number }`.
- `mergeTranscripts(chunks: TranscriptSegment[][]): TranscriptSegment[]`.

- [ ] **Step 1: Test de frontera**: audio que cae justo en el límite → no se pierde ni se duplica texto.
- [ ] **Step 2: Test de solape**: dos segmentos con 2 s de solape → `mergeTranscripts` elimina la duplicación.
- [ ] **Step 3: Implementar** el corte y el merge por similitud normalizada.
- [ ] **Step 4: Ejecutar** tests.
- [ ] **Step 5: Commit.**

**Review Focus #3** cubierto aquí.

---

# Fase 3 — Transcripción

### Task 12: Whisper local

**Files:** Create `transcribe.worker.ts`, `transcribe-local.ts`, `transcribe-local.test.ts`, `features/transcripcion.feature`

**Interfaces:**
- `transcribeLocal(audio: Float32Array, opts: { model: "base" | "small"; onProgress?: (p: number) => void }): Promise<TranscriptSegment[]>`
- Consume `TranscriptSegment` definido en Task 11.

- [ ] **Step 1: Test** con un fixture de 10 s y transcripción esperada (tolerancia por palabras clave).
- [ ] **Step 2: Implementar** el Worker con `@huggingface/transformers`, `webgpu` + fallback `wasm`.
- [ ] **Step 3: Test de fallback**: sin WebGPU → sigue funcionando en `wasm`.
- [ ] **Step 4: Ejecutar** y medir (no bloquear el hilo principal).
- [ ] **Step 5: Commit.**

---

### Task 13: Proxy `/v1/transcribe`

**Files:** Create `apps/api/src/modules/clipping/transcribe.route.ts`, `transcribe.route.test.ts`, `providers/groq.ts`; Modify `apps/api/src/index.ts`

**Interfaces:**
- `POST /v1/transcribe` (multipart) → `{ segments: TranscriptSegment[]; language: string }`.
- Error codes: `UNSUPPORTED_MEDIA`, `UPSTREAM_ERROR`, `QUOTA_EXCEEDED`, `UNAUTHORIZED`.

- [ ] **Step 1: Test de integración** con `app.handle(new Request(...))` y un mock de Groq (fixture `verbose_json`).
- [ ] **Step 2: Implementar el passthrough** de `request.body` sin parsear y sin base64.
- [ ] **Step 3: Test de error**: el proveedor devuelve 500 con stack → la respuesta es `502 UPSTREAM_ERROR` sin filtrar detalles.
- [ ] **Step 4: Test de tamaño**: 26 MB → `413` antes de llamar al proveedor.
- [ ] **Step 5: Commit.**

Cubre el error de proveedor (`UPSTREAM_ERROR`); el 429 y su degradación se prueban en Task 14.

---

### Task 14: BYOK, consentimiento, cuota y Turnstile

**Files:** Create `apps/web/src/lib/clipping/byok.ts`, `apps/api/src/modules/clipping/quota.ts`, `features/seguridad.feature`, `features/cuotas.feature`

**Interfaces:**
- `setProviderKey(key: string): void`, `clearProviderKey(): void`, `hasProviderKey(): boolean` (sessionStorage, nunca localStorage).
- `consumeQuota(ipHash: string): Promise<{ allowed: boolean; remaining: number }>` en D1.

- [ ] **Step 1: Escenarios Gherkin** de clave no persistida y cuota agotada.
- [ ] **Step 2: Test** de que la clave no aparece en logs, ni en D1, ni en la respuesta (`Cache-Control: no-store`).
- [ ] **Step 3: Implementar** Turnstile + límite diario por IP hash.
- [ ] **Step 4: Test** de 429 → el cliente ofrece el modo local.
- [ ] **Step 5: Commit.**

**Review Focus #4** cubierto aquí (429 → degradación a local).

---

# Fase 4 — Cortes

### Task 15: `cut-validator` (TDD, 100 % cobertura)

**Files:** Create `cut-validator.ts`, `cut-validator.test.ts`, `contracts.ts`, `features/cortes.feature`

**Interfaces:**
- `validateCuts(input: unknown, media: { durationMs: number }): ClipCandidate[]`
- `ClipCandidate = { id: string; startMs: number; endMs: number; title: string; score: number }`

**Valores exactos:** 15 000 ≤ duración ≤ 180 000 ms; `0 ≤ start < end ≤ durationMs`; sin solapes; orden ascendente; máx. 20; snap ±750 ms; IoU > 0,8 descarta; título ≤ 80 caracteres sin control ni HTML.

- [ ] **Step 1: Escribir los casos límite uno por uno** (duración mínima, máxima, negativo, solape, desorden, 21 cortes, título vacío, título con `<script>`).
- [ ] **Step 2: Implementar** hasta que pasen todos.
- [ ] **Step 3: Verificar cobertura 100 %.**
- [ ] **Step 4: Ejecutar** `moon run api:test`.
- [ ] **Step 5: Commit.**

---

### Task 16: Heurísticas locales

**Files:** Create `apps/web/src/lib/clipping/local-cuts.ts`, `local-cuts.test.ts`

**Interfaces:**
- `scoreWindows(segments: TranscriptSegment[], brief: string): ClipCandidate[]` (determinista, sin red).

- [ ] **Step 1: Test** de transcript conocido → cortes esperados (preguntas, cifras, keywords del brief).
- [ ] **Step 2: Implementar** el scoring por ventana.
- [ ] **Step 3: Test de determinismo**: misma entrada dos veces → misma salida.
- [ ] **Step 4: Ejecutar** tests.
- [ ] **Step 5: Commit.**

---

### Task 17: Análisis con LLM (opcional)

**Files:** Create `analyze.route.ts`, `analyze.route.test.ts`, `providers/workers-ai.ts`

**Interfaces:**
- `POST /v1/analyze` → `{ cuts: ClipCandidate[] }`; entrada `{ segments, brief, durationMs }`.
- Fallback interno: LLM → heurísticas → `[]`.

- [ ] **Step 1: Test** con respuesta válida y con respuesta con HTML → el validador descarta.
- [ ] **Step 2: Implementar** la llamada a `env.AI.run` con JSON schema y `Zod` en la salida.
- [ ] **Step 3: Test de fallback**: LLM caído o 429 → se devuelven las heurísticas.
- [ ] **Step 4: Ejecutar** tests.
- [ ] **Step 5: Commit.**

**Review Focus #5** (completo) cubierto aquí.

---

# Fase 5 — Export y UI

### Task 18: Export de clips

**Files:** Create `apps/web/src/lib/clipping/clip-export.ts`, `clip-export.test.ts`

**Interfaces:**
- `exportClip(file: File, cut: ClipCandidate, opts: { precise: boolean }): Promise<Blob>`.

- [ ] **Step 1: Test** de rango: `startMs`/`endMs` se respetan con tolerancia de un GOP.
- [ ] **Step 2: Implementar** `-ss`/`-to`/`-c copy`; `precise: true` recodifica el primer GOP.
- [ ] **Step 3: Test de corte inválido** → rechazo antes de invocar ffmpeg.
- [ ] **Step 4: Ejecutar** tests.
- [ ] **Step 5: Commit.**

---

### Task 19: Máquina de estados del job

**Files:** Create `apps/web/src/lib/clipping/use-clipping-job.ts`

**Interfaces:**
- `useClippingJob(): { state: JobState; start: (file: File, brief: string) => Promise<void>; cancel: () => void }`.

- [ ] **Step 1: Test de transiciones** `idle → extracting → transcribing → analyzing → completed`.
- [ ] **Step 2: Test de fallo y cancelación** → `failed` con código genérico.
- [ ] **Step 3: Implementar** con unión discriminada y `switch` exhaustivo (sin `any`).
- [ ] **Step 4: Ejecutar** tests.
- [ ] **Step 5: Commit.**

---

# Fase 6 — Cierre

### Task 20: Observabilidad y errores

**Files:** Modify `apps/api/src/index.ts`, `apps/web/src/lib/clipping/use-clipping-job.ts`

- [ ] **Step 1: Definir `ErrorCode`** y el mapeo a mensajes de usuario.
- [ ] **Step 2: Añadir `correlationId`** a cada job y a las respuestas de error.
- [ ] **Step 3: Redactar** `authorization` y `x-provider-key` en logs y en Sentry.
- [ ] **Step 4: Test** de que el stack nunca aparece en la respuesta.
- [ ] **Step 5: Commit.**

---

### Task 21: E2E BDD y gate final

**Files:** Create `features/*.feature` (runner), `playwright.config.ts`, `.github/workflows/e2e.yml`

- [ ] **Step 1: Conectar los `.feature`**: `@cucumber/cucumber` + `tsx` para los escenarios de dominio y API (sobre `app.handle`), y `playwright-bdd` para los de UI. Comparten los mismos `.feature`.
- [ ] **Step 2: Ejecutar los escenarios `@seguridad`** en cada PR (con fixtures, sin llamadas reales).
- [ ] **Step 3: Ejecutar un smoke E2E** con un vídeo de 30 s y el modo local.
- [ ] **Step 4: Verificar el gate completo:** `moon ci` + coverage + gitleaks + semgrep + osv + e2e.
- [ ] **Step 5: Commit y tag** `v0.1.0-local`.

**Definition of Done (Reglas 1-4):**

- [ ] Todos los `.feature` en verde.
- [ ] Cobertura ≥ 80 % y 100 % en los tres ficheros críticos.
- [ ] `tsc --noEmit` y `biome check` limpios.
- [ ] `bun audit` sin altas/críticas.
- [ ] Ningún secreto en el bundle (`gitleaks` + grep de `VITE_`).
- [ ] Manual: un vídeo de 30 s genera clips exportables sin salir del dispositivo.

---

## Riesgos abiertos que este plan no resuelve

1. **Build sobre rewrite vs. classic** — decisión de producto pendiente; si es classic, las tareas 5, 9, 10, 18 y 19 cambian de API.
2. **ToS de Groq** — revisión legal antes de exponer el modo nube a terceros.
3. **Precisión de cortes** — keyframe ±2-10 s; el modo `precise` es más lento.
4. **Safari/iOS** — fuera del MVP; requiere WebCodecs y pruebas en dispositivo real.
