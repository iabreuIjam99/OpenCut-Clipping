# language: es
#
# Fuente de verdad BDD de la ingesta local (Task 9).
# No se ejecuta con Cucumber: cada escenario tiene un test Vitest 1:1 en
# `src/lib/clipping/media-guard.test.ts` cuyo nombre cita el escenario.
#
# Correspondencia:
#   1. Aceptar un MP4 con audio dentro de los limites
#      → it("Scenario: Aceptar un MP4 con audio dentro de los limites")
#   2. Rechazar un fichero con MIME de video pero bytes de texto
#      → it("Scenario: Rechazar un fichero con MIME de video pero bytes de texto")
#   3. Rechazar por tamano mayor de 4 GiB sin leer el fichero
#      → it("Scenario: Rechazar por tamano mayor de 4 GiB sin leer el fichero")
#   4. Rechazar por duracion mayor de 3 horas
#      → it("Scenario: Rechazar por duracion mayor de 3 horas")
#   5. Rechazar un MP4 sin pista de audio
#      → it("Scenario: Rechazar un MP4 sin pista de audio")
#   6. Rechazar un WebM sin pista de audio
#      → it("Scenario: Rechazar un WebM sin pista de audio")
#   7. Rechazar en movil aunque el fichero sea valido
#      → it("Scenario: Rechazar en movil aunque el fichero sea valido")
#   8. Aceptar un MOV y distinguirlo de un MP4
#      → it("Scenario: Aceptar un MOV y distinguirlo de un MP4")
#   9. Rechazar un contenedor corrupto con magic bytes validos
#      → it("Scenario: Rechazar un contenedor corrupto con magic bytes validos")
#
# Orden obligatorio de comprobaciones:
#   dispositivo → tamaño → contenedor (magic bytes) → duración → pista de audio.
#
# Los tests adicionales de `media-guard.test.ts` cubren ramas internas del parser
# (truncados, largesize, presupuesto de lectura, DocType desconocido, etc.) y no
# corresponden a un escenario de este fichero.

Característica: Ingesta de un vídeo local
  Como usuario de escritorio
  Quiero validar el fichero antes de gastar memoria o CPU
  Para que solo se procesen vídeos soportados con audio

  Escenario: 1. Aceptar un MP4 con audio dentro de los limites
    Dado un fichero MP4 con marca isom, 2 s y pista de audio
    Y un dispositivo de escritorio
    Cuando se llama a validateMediaFile
    Entonces el resultado tiene contenedor "mp4"
    Y hasAudio es verdadero
    Y durationMs es 2000

  Escenario: 2. Rechazar un fichero con MIME de video pero bytes de texto
    Dado un fichero con type "video/mp4" y bytes de texto plano
    Cuando se llama a validateMediaFile
    Entonces el error es UNSUPPORTED_MEDIA
    Y el mensaje no contiene detalles técnicos

  Escenario: 3. Rechazar por tamano mayor de 4 GiB sin leer el fichero
    Dado un fichero cuyo tamaño declarado supera 4 GiB
    Cuando se llama a validateMediaFile
    Entonces el error es FILE_TOO_LARGE
    Y no se ha solicitado ningún slice del fichero

  Escenario: 4. Rechazar por duracion mayor de 3 horas
    Dado un fichero MP4 o Matroska cuya duración es 10 800 001 ms
    Cuando se llama a validateMediaFile
    Entonces el error es DURATION_EXCEEDED

  Escenario: 5. Rechazar un MP4 sin pista de audio
    Dado el fixture real no-audio.mp4
    Cuando se llama a validateMediaFile
    Entonces el error es NO_AUDIO_TRACK

  Escenario: 6. Rechazar un WebM sin pista de audio
    Dado el fixture real no-audio.webm
    Cuando se llama a validateMediaFile
    Entonces el error es NO_AUDIO_TRACK

  Escenario: 7. Rechazar en movil aunque el fichero sea valido
    Dado un fichero MP4 válido
    Y un dispositivo detectado como móvil
    Cuando se llama a validateMediaFile
    Entonces el error es UNSUPPORTED_DEVICE

  Escenario: 8. Aceptar un MOV y distinguirlo de un MP4
    Dado un fichero ISO-BMFF con marca "qt  "
    Cuando se llama a validateMediaFile
    Entonces el resultado tiene contenedor "mov"
    Y un fichero con marca "mp42" tiene contenedor "mp4"

  Escenario: 9. Rechazar un contenedor corrupto con magic bytes validos
    Dado un fichero con ftyp válido y una marca desconocida
    O un fichero Matroska con cabecera EBML válida y Segment truncado
    Cuando se llama a validateMediaFile
    Entonces el error es UNSUPPORTED_MEDIA
    Y ninguna excepción no controlada alcanza al llamador
