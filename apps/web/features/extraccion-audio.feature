# language: es
#
# Fuente de verdad BDD de la extraccion de audio (Task 10).
# No se ejecuta con Cucumber: cada escenario tiene un test Vitest 1:1 en
# `src/lib/media/extract-audio.test.ts` cuyo nombre cita el escenario.
#
# Correspondencia:
#   1. Extraer audio de un MP4 de 5 s
#      → it("Scenario: Extraer audio de un MP4 de 5 s")
#   2. Cancelar con AbortSignal
#      → it("Scenario: Cancelar con AbortSignal")
#   3. ffmpeg falla (exit != 0)
#      → it("Scenario: ffmpeg falla (exit != 0)")
#
# Los tests adicionales de `extract-audio.test.ts` (args exactos, recorte de
# progreso, fallos de mount/readFile/load/limpieza, guard llamado una sola vez,
# señal ya abortada) cubren ramas internas de la orquestacion y no corresponden
# a un escenario de este fichero. El adaptador `ffmpeg-runtime.ts` se prueba por
# separado con `vi.mock("@ffmpeg/ffmpeg")`.

Característica: Extracción de audio de un vídeo local
  Como usuario de escritorio
  Quiero extraer el audio de un vídeo validado con ffmpeg.wasm
  Para obtener una pista Opus sin cargar el vídeo en memoria

  Escenario: 1. Extraer audio de un MP4 de 5 s
    Dado el fixture real clip-5s.mp4 con pista de audio
    Y un runtime de ffmpeg inyectado
    Cuando se llama a extractAudio
    Entonces el resultado tiene codec "opus"
    Y blob.type es "audio/webm"
    Y blob.size es mayor que 0
    Y durationMs está dentro de 5000 ± 200
    Y el progreso es monótono de 0 a 1

  Escenario: 2. Cancelar con AbortSignal
    Dado el fixture real clip-5s.mp4 con pista de audio
    Y un AbortSignal que se cancela mientras ffmpeg ejecuta
    Cuando se llama a extractAudio
    Entonces el error es AbortedError
    Y terminate() ha sido llamado
    Y unmount, deleteFile y deleteDir no han sido llamados

  Escenario: 3. ffmpeg falla (exit != 0)
    Dado el fixture real clip-5s.mp4 con pista de audio
    Y un runtime cuyo exec devuelve código de salida 1
    Cuando se llama a extractAudio
    Entonces el error es AudioExtractionError con código EXTRACTION_FAILED
    Y la limpieza completa se ha ejecutado
    Y el motivo técnico no se filtra al llamador
