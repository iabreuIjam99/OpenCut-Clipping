# language: es
#
# Fuente de verdad BDD de la transcripcion local con Whisper (Task 12).
# No se ejecuta con Cucumber: cada escenario tiene un test Vitest 1:1 en
# `src/lib/media/transcribe-local.test.ts` cuyo nombre cita el escenario.
#
# Correspondencia:
#   1. Transcribir un audio de 10 s devuelve segmentos con tiempos absolutos
#      → it("Scenario: Transcribir un audio de 10 s devuelve segmentos con tiempos absolutos")
#   2. Sin WebGPU, el Worker cae a WASM y sigue devolviendo segmentos
#      → it("Scenario: Sin WebGPU, el Worker cae a WASM y sigue devolviendo segmentos")
#   3. Cancelar con AbortSignal termina el Worker y rechaza con ABORTED
#      → it("Scenario: Cancelar con AbortSignal termina el Worker y rechaza con ABORTED")
#   4. Un error del modelo se convierte en TRANSCRIPTION_FAILED genérico (sin filtrar rutas ni mensajes de ORT)
#      → it("Scenario: Un error del modelo se convierte en TRANSCRIPTION_FAILED genérico (sin filtrar rutas ni mensajes de ORT)")
#   5. El progreso es monótono de 0 a 1 y termina en 1
#      → it("Scenario: El progreso es monótono de 0 a 1 y termina en 1")
#
# Los tests adicionales de `transcribe-local.test.ts` (petición exacta,
# transferencia del buffer, `terminate()` una vez, `NO_AUDIO` y señal ya
# abortada sin crear el Worker, mensajes basura del Worker, etc.) y los de
# `transcribe-protocol.test.ts` (`toSegments`, `isTranscribeResponse`,
# `isTranscribeRequest`) cubren ramas internas y no corresponden a un escenario
# de este fichero. El fallback REAL WebGPU→WASM dentro del Worker (R6) no es
# ejecutable en jsdom: se valida en el smoke de navegador (R8), no aquí.

Característica: Transcripción local de audio con Whisper en un Web Worker
  Como usuario de escritorio
  Quiero transcribir el audio con Whisper local dentro de un Web Worker
  Para obtener segmentos con tiempos absolutos sin salir del equipo

  Escenario: 1. Transcribir un audio de 10 s devuelve segmentos con tiempos absolutos
    Dado un audio Float32Array de 10 s y durationMs 10000
    Y un Worker falso que responde con los segmentos del fixture whisper-base-10s
    Cuando se llama a transcribeLocal
    Entonces el resultado tiene 3 segmentos con tiempos absolutos
    Y los rangos son 0–2840, 2840–6420 y 6420–10000 ms
    Y el texto conserva los acentos del fixture
    Y la petición al Worker lleva type "transcribe", model "base" y language "es"

  Escenario: 2. Sin WebGPU, el Worker cae a WASM y sigue devolviendo segmentos
    Dado un Worker falso que responde `result` con device "wasm"
    Cuando se llama a transcribeLocal
    Entonces la promesa resuelve con los segmentos del Worker
    Y el buffer del audio se transfiere en la petición

  Escenario: 3. Cancelar con AbortSignal termina el Worker y rechaza con ABORTED
    Dado un Worker falso que nunca responde
    Y un AbortSignal que se cancela con la petición en vuelo
    Cuando se llama a transcribeLocal y se aborta
    Entonces el error es TranscriptionAbortedError con código ABORTED
    Y terminate() ha sido llamado una sola vez
    Y el listener "message" del Worker ha sido retirado

  Escenario: 4. Un error del modelo se convierte en TRANSCRIPTION_FAILED genérico (sin filtrar rutas ni mensajes de ORT)
    Dado un Worker falso que responde `error` con code "TRANSCRIPTION_FAILED"
    Cuando se llama a transcribeLocal
    Entonces el error es TranscriptionError con código TRANSCRIPTION_FAILED
    Y el message es "No se pudo transcribir el audio."
    Y el message no contiene rutas ni mensajes técnicos de ORT/transformers

  Escenario: 5. El progreso es monótono de 0 a 1 y termina en 1
    Dado un Worker falso que emite progreso 0.4, 0.2, 0.9 y 1.5 y luego `result`
    Cuando se llama a transcribeLocal con onProgress
    Entonces los valores emitidos son [0, 0.4, 0.9, 1]
    Y la serie es monótona creciente y termina en 1
