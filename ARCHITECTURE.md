# MonetizaClip — Arquitectura del agente de clipping (coste cero, local-first)

**Estado:** v3 · 2026-11-07
**Reemplaza:** diseño v1 (R2 + Containers + Queues) y v2 (audio subido a R2).
**Spec del plan:** `plan.md`

---

## 0. Contexto real del repositorio

| Hecho | Implicación |
|---|---|
| Es el **rewrite** de OpenCut, no la versión clásica | No hay WebGL, ni motor de timeline, ni gestión de estado |
| `apps/web/src/routes/editor.tsx` es un stub ("Coming soon") | La integración con el editor se construye desde cero |
| `apps/api` es Elysia sobre Cloudflare Workers con 3 rutas | Es el único backend; el agente vive ahí |
| Rust/GPUI (`apps/desktop`) y FFmpeg pineado en `crates/media` | Útiles para el escritorio; **irrelevantes para el flujo web** |
| Sin lockfile, sin tests, sin lint, sin `.git` | Bloqueantes de la Fase 0 de `plan.md` |
| `docs/` está en `.gitignore` | Esta documentación vive en la raíz |

**Decisión pendiente (bloqueante):** construir sobre este rewrite (editor vacío) o sobre `opencut-classic`. Todo este documento asume el rewrite con la ruta del editor en modo cliente.

---

## 1. Principios

1. **Coste marginal $0 por usuario.** Nada de planes de pago, contenedores ni colas.
2. **El vídeo nunca sale del dispositivo.** Solo el audio, y solo si el usuario activa el modo nube.
3. **Local por defecto, nube opt-in.** La ruta gratuita e ilimitada es la predeterminada.
4. **Fallar cerrado y ruidoso.** Sin cuota → mensaje claro; sin clave → modo local.
5. **Todo dato externo es hostil.** Transcript, títulos y salida del LLM se validan y se tratan como texto.

---

## 2. Flujo v3

```
[NAVEGADOR]  ← ruta por defecto: gratis e ilimitada
  video ──WORKERFS──► ffmpeg.wasm (1 hilo) ──► audio 16 kHz mono, 24 kbps ≈ 11 MB/h
                                                        │
        ┌───────────────────────────────────────────────┴──────────────┐
        │ MODO LOCAL (defecto)                    MODO NUBE (opt-in)   │
        ▼                                                              ▼
  Whisper WebGPU (80-250 MB, 1 vez)                    Proxy → Groq (BYOK)
  + heurísticas de corte                               + Workers AI (texto)
        │                                                              │
        └──────────────► cut-validator (Zod) ◄────────────────────────┘
                                   ▼
                    ffmpeg.wasm -ss/-to -c copy → clips locales
```

---

## 3. Decisiones (ADR)

| ID | Decisión | Alternativa descartada | Motivo |
|---|---|---|---|
| ADR-01 | El vídeo se monta con **WORKERFS**, nunca se copia al heap WASM | `writeFile(arrayBuffer)` | Límite duro de 2 GB y OOM desde ~400-800 MB |
| ADR-02 | Audio **16 kHz mono, Opus 24 kbps** (fallback MP3 32 kbps) | WAV (115 MB/h) | 11 MB/h cabe en límites de proveedor |
| ADR-03 | Transcripción **local por defecto** (WebGPU) | Groq como primario | $0 real, sin ToS ajenos, sin cuotas |
| ADR-04 | Groq **solo opt-in con BYOK** | Clave del proyecto | Free tier es por organización: no escala |
| ADR-05 | **Sin R2/D1 obligatorios**; D1 solo para contadores de cuota | R2 para el vídeo | 10 GB gratis se agotan con un usuario |
| ADR-06 | **Heurísticas locales** como fallback del LLM | Depender del LLM siempre | Determinista, gratis, offline |
| ADR-07 | Ruta del editor en **client-only** | SSR | Workers Free = 10 ms de CPU por request |
| ADR-08 | Validador de cortes **puro y determinista** | Confiar en el LLM | El LLM propone; el validador decide |

---

## 4. Pipeline

### 4.1 Ingesta y límites

| Límite | Valor | Acción al exceder |
|---|---|---|
| Tamaño de entrada | 4 GB | Rechazo `FILE_TOO_LARGE` |
| Duración | 3 h | Rechazo `DURATION_EXCEEDED` |
| Dispositivo | Desktop Chrome/Firefox; móvil fuera del MVP | `UNSUPPORTED_DEVICE` |
| Contenedores | MP4/MOV/WebM/MKV (magic bytes, no extensión) | `UNSUPPORTED_MEDIA` |
| Pista de audio | Obligatoria | `NO_AUDIO_TRACK` |

La validación de magic bytes **no** sustituye al decodificador del navegador; sirve para rechazar basura antes de gastar memoria.

### 4.2 Extracción de audio

```ts
await ffmpeg.createDir("/input");
await ffmpeg.mount("WORKERFS", { files: [videoFile] }, "/input");
await ffmpeg.exec([
  "-i", `/input/${videoFile.name}`,
  "-vn", "-sn", "-dn",
  "-map_metadata", "-1",
  "-ac", "1", "-ar", "16000",
  "-c:a", "libopus", "-b:a", "24k",
  "-f", "webm", "/out/audio.webm",
]);
```

Reglas:
- La salida va a MEMFS: debe ser pequeña (audio, no vídeo).
- Si `libopus` no está en el core elegido → `libmp3lame -b:a 32k`.
- Un `AudioContext.decodeAudioData` posterior da el `Float32Array` que necesita Whisper, sin recodificar.
- Progreso vía evento `progress`; cancelación con `ffmpeg.terminate()`.
- Limpieza obligatoria: `unmount` + `deleteDir` + `deleteFile`.

### 4.3 Segmentación para la nube

Solo aplica al modo nube. Se corta en segmentos de **30 min** (~5,4 MB a 24 kbps) con **2 s de solape**, y se reajustan offsets. El solape se deduplica comparando el texto de la cola del segmento N con la cabeza del N+1 (similitud normalizada) antes de concatenar.

### 4.4 Transcripción

**Local (defecto):** `@huggingface/transformers` en un Web Worker, modelo `onnx-community/whisper-base` (subir a `whisper-small` si la GPU lo permite), `device: "webgpu"` con fallback a `wasm`, `chunk_length_s: 30`, `stride_length_s: 5`, `return_timestamps: "word"`. El modelo se cachea en IndexedDB.

**Nube (opt-in):** `POST /v1/transcribe` → Groq `whisper-large-v3-turbo`, `response_format: verbose_json`, `timestamp_granularities: ["word"]`.

**Cadena de degradación:** local → nube (si hay clave) → error accionable. Nunca al revés.

**Workers AI Whisper** queda descartado como fallback: 25 MB reales, entrada base64 (×1,33), CPU por encima de 10 ms en plan Free y 128 MB de isolate. Solo se usaría para clips < 2 MB.

### 4.5 Análisis de cortes

1. **Heurísticas locales** (`score-segments.ts`): puntúa ventanas de 15-180 s por densidad de preguntas, cifras, palabras clave del brief, cambios de energía y silencios. Determinista y testeable.
2. **LLM opcional** (Workers AI `@cf/openai/gpt-oss-20b`, o BYOK de Groq/OpenCode): recibe el transcript delimitado y devuelve JSON. Una sola llamada por ventana de 30 min para no superar cuotas.

El LLM **no** ejecuta herramientas, no elige URLs y no escribe en disco.

### 4.6 Validador de cortes (`cut-validator.ts`)

Valores exactos:

| Regla | Valor |
|---|---|
| Duración mínima | 15 000 ms |
| Duración máxima | 180 000 ms |
| Rango | `0 ≤ start < end ≤ duración del medio` |
| Solapes | Prohibidos |
| Orden | Ascendente por `start` |
| Máximo de cortes | 20 |
| Ajuste a palabra | ±750 ms |
| Duplicados | IoU > 0,8 → descartar |
| Título | ≤ 80 caracteres, sin caracteres de control ni HTML |

Cualquier corte inválido se descarta; la respuesta nunca incluye un timestamp sin validar.

### 4.7 Export

`ffmpeg.wasm -ss <start> -to <end> -c copy` → corte en el keyframe anterior (desfase de 2-10 s según GOP). Se documenta como "corte rápido"; la opción "preciso" recodifica el primer GOP y es más lenta. Sin recodificación completa.

---

## 5. Cuotas y matemáticas del $0

| Recurso | Free tier verificado (nov-2026) | Consumo por 1 h de audio | Capacidad |
|---|---|---|---|
| Workers Free | 100 000 req/día, 10 ms CPU, 128 MB, body 100 MB | ~3 req | Sobra |
| Groq `whisper-large-v3-turbo` | 20 RPM · 2 000 req/día · 7 200 s/h · **28 800 s/día (8 h)** · 25 MB/fichero | 3 600 s | **8 h/día**, 2 h/hora |
| Workers AI | 10 000 neuronos/día | ~100-200 neuronos (texto) | ~50 h de análisis |
| D1 | 5 GB, 5 M lecturas/día, 100 k escrituras/día | 1 escritura/job | Sobra |
| R2 | **no se usa** | — | — |

**Cuello de botella real:** la cuota de audio de Groq (8 h/día **por organización**), no la infraestructura. Por eso el modo nube es opt-in y cada usuario aporta su clave.

**Restricción de plataforma:** los 100 000 req/día son por cuenta, sumando todos los Workers.

---

## 6. Seguridad y privacidad

### 6.1 Secretos

| Secreto | Almacenamiento | Consumidor |
|---|---|---|
| Claves de proveedor del proyecto | Worker Secret / Secrets Store | solo `apps/api` |
| Clave BYOK del usuario | `sessionStorage` + cabecera por request | `apps/api` como proxy efímero |
| Sesión | cookie `HttpOnly; Secure; SameSite=Lax` | web + api |

Prohibido: prefijo `VITE_` para secretos, persistir la clave BYOK en servidor o en logs, `Cache-Control` distinto de `no-store` en respuestas con clave.

### 6.2 BYOK

- Se guarda en `sessionStorage` (se borra al cerrar pestaña) y nunca en `localStorage`.
- Se envía en `x-provider-key` sobre TLS; el Worker la usa en memoria y la descarta.
- Redacción obligatoria de `authorization` y `x-provider-key` en logs y en Sentry.
- Si el usuario no aporta clave, el modo nube no se ofrece: no hay clave del proyecto en el flujo de usuario.

### 6.3 Validación de entrada

- `Content-Length` ≤ 25 MB por segmento; `Content-Type` solo informativo.
- Magic bytes: ISO-BMFF `ftyp`, Matroska `1A45DFA3`, Ogg `OggS`, MP3 `ID3`/`0xFFFB`, FLAC `fLaC`.
- Rechazo de políglotas y de ficheros sin pista de audio, antes de decodificar.
- Nombre de fichero saneado a UUID; nunca se interpola en comandos.

### 6.4 Ataques del contenido

| Vector | Control |
|---|---|
| SSRF | No se aceptan URLs: solo `File` locales y objetos propios. Sin `-protocol_whitelist` ampliado |
| XSS | Transcript y títulos se renderizan como texto; prohibido `dangerouslySetInnerHTML` con datos del agente |
| Prompt injection | Transcript delimitado + instrucción de "dato no confiable" + **validador de salida como control real** |
| Inyección de fichero | ffmpeg en Web Worker sin DOM; `worker-src 'self' blob:` |
| Fuga de clave | CSP estricta, cero scripts de terceros, `no-store` |

### 6.5 Abuso del proxy

`/v1/transcribe` es un relay: sin controles, vacía la cuota.
- Allowlist de `Origin`.
- **Turnstile** (gratis) en el primer uso.
- Límite por IP hash/día en D1 → `429 QUOTA_EXCEEDED`.
- Timeout de 120 s y `AbortSignal`.

### 6.6 Errores y logs

Al usuario: código + `correlationId`. Nunca stack, nombre de proveedor ni respuesta cruda. Los detalles van a logs estructurados y a Sentry (plan gratuito) con `beforeSend` que redacta cabeceras y recorta el transcript.

### 6.7 Cumplimiento (revisión legal pendiente)

- `agent.md` exige que las claves nunca estén en el cliente: se cumple (BYOK viaja en memoria, no en el bundle).
- **Groq:** su Services Agreement dice *"not for consumer use"* y prohíbe eludir límites del free tier. Integrarlo en un producto de consumo requiere revisión legal. El modo local evita el problema.
- **GDPR:** consentimiento explícito antes del modo nube, retención 0, sin entrenamiento con datos del usuario.
- El free tier de Gemini **entrena con los datos**: descartado para contenido de usuario.

---

## 7. Estado del frontend

```ts
type JobState =
  | { status: "idle" }
  | { status: "extracting"; progress: number }
  | { status: "transcribing"; mode: "local" | "cloud"; progress: number }
  | { status: "analyzing" }
  | { status: "completed"; clips: ClipCandidate[] }
  | { status: "failed"; code: ErrorCode; correlationId?: string };
```

- TanStack Query solo para el modo nube; el modo local no sale del navegador.
- Sin Redux. Sin secretos en estado. Sin blobs de vídeo en stores.
- Todo payload de red se parsea con Zod; prohibido `any`.
- Persistencia local: solo IDs y preferencias.

---

## 8. Estructura de módulos

```
apps/web/src/
  lib/clipping/
    extract-audio.ts          # WORKERFS + ffmpeg.wasm
    chunk-audio.ts            # segmentación + solape
    transcribe.worker.ts      # Whisper WebGPU
    local-cuts.ts             # heurísticas
    use-clipping-job.ts       # máquina de estados
    clip-export.ts            # -ss/-to -c copy
apps/api/src/
  config/env.ts               # Zod, fail-closed
  modules/clipping/
    transcribe.route.ts       # proxy streaming a Groq
    analyze.route.ts          # LLM opcional
    quota.ts                  # contadores D1
    providers/groq.ts
    providers/workers-ai.ts
    cut-validator.ts          # 100 % cobertura
    contracts.ts              # Zod compartido
features/
  ingesta.feature
  transcripcion.feature
  cortes.feature
  seguridad.feature
  cuotas.feature
```

`packages/contracts` queda para cuando se compartan tipos con el escritorio; requiere añadir `packages/*` a `.moon/workspace.yml`.

---

## 9. Observabilidad

- `correlationId` por job, propagado al proveedor sin datos personales.
- Métricas: `extract_ms`, `transcribe_ms`, `analyze_ms`, `fallback_used`, `clips_returned`, `quota_rejected`.
- Alertas: tasa de `UNSUPPORTED_MEDIA` (posible ataque) y de `QUOTA_EXCEEDED` (cuota agotada o abuso).

---

## 10. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|
| WORKERFS + `libopus` no disponible | Media | Alto | Spike previo; fallback MP3/WebCodecs |
| Safari/iOS OOM | Alta | Medio | Fuera del MVP; rechazo explícito |
| Cuota Groq agotada | Alta | Medio | Local por defecto; 429 accionable |
| ToS de Groq | Media | Alto | Revisión legal; local-first |
| 10 ms de CPU en SSR | Alta | Alto | Editor client-only; proxy streaming |
| Precisión de cortes por keyframe | Alta | Bajo | Documentado; modo "preciso" opcional |
| Cambio de límites del free tier | Alta | Medio | Constantes en config, no hardcodeadas |

---

## 11. Supuestos a validar en el spike (Fase 1 de `plan.md`)

1. WORKERFS extrae audio de un fichero de 2 GB en Chrome de escritorio sin OOM.
2. El core de ffmpeg.wasm elegido incluye `libopus` (o se usa el fallback).
3. Whisper-base WebGPU transcribe 10 min en menos de 3 min en hardware medio.
4. El proxy de un multipart de 20 MB se mantiene por debajo de 10 ms de CPU.
5. El coste real por 1 h de audio en Groq se corresponde con la cuota documentada.
