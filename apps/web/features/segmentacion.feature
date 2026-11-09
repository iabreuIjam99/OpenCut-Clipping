# language: es
#
# Fuente de verdad BDD de la segmentacion de audio (Task 11).
# No se ejecuta con Cucumber: cada escenario tiene un test Vitest 1:1 en
# `src/lib/media/chunk-audio.test.ts` cuyo nombre cita el escenario.
#
# Correspondencia:
#   1. Planificar 1 h en segmentos de 30 min con 2 s de solape
#      → it("Scenario: Planificar 1 h en segmentos de 30 min con 2 s de solape")
#   2. Un audio más corto que el límite → un solo segmento
#      → it("Scenario: Un audio más corto que el límite → un solo segmento")
#   3. El límite de bytes nunca se supera (estimación)
#      → it("Scenario: El límite de bytes nunca se supera (estimación)")
#   4. Dos chunks con 2 s de solape y texto equivalente → el merge no duplica
#      → it("Scenario: Dos chunks con 2 s de solape y texto equivalente → el merge no duplica")
#   5. Una repetición legítima en tiempos distintos → se conserva
#      → it("Scenario: Una repetición legítima en tiempos distintos → se conserva")
#
# Los tests adicionales de `chunk-audio.test.ts` (solape 0, entradas inválidas o
# no finitas, cota MAX_CHUNKS contra entradas que estancan el bucle, maxBytes
# pequeño, cortador inyectado, runtime falso con args exactos y limpieza,
# readFile no binario, sonda que falla o devuelve duración 0 o NaN) cubren
# ramas internas de la orquestación y no corresponden a un escenario de este
# fichero.

Característica: Segmentación de audio y merge de transcripciones
  Como usuario de escritorio
  Quiero dividir el audio en segmentos de 30 min con 2 s de solape
  Para transcribir en la nube sin perder ni duplicar texto

  Escenario: 1. Planificar 1 h en segmentos de 30 min con 2 s de solape
    Dado un audio de 3600000 ms que pesa 10800000 bytes
    Y un límite de 5400000 bytes por segmento
    Y un solape de 2000 ms
    Cuando se llama a planChunks
    Entonces se obtienen 3 rangos
    Y el primer rango empieza en 0
    Y el último rango termina en 3600000
    Y cada rango solapa exactamente 2000 ms con el siguiente

  Escenario: 2. Un audio más corto que el límite → un solo segmento
    Dado un audio de 60000 ms que pesa 180000 bytes
    Y un límite de 5400000 bytes por segmento
    Y un solape de 2000 ms
    Cuando se llama a planChunks
    Entonces se obtiene un solo rango de 0 a 60000

  Escenario: 3. El límite de bytes nunca se supera (estimación)
    Dado un audio de 3600000 ms que pesa 10800000 bytes
    Y un límite de 5400000 bytes por segmento
    Cuando se llama a planChunks con varios límites y solapes
    Entonces cada rango estimado pesa como máximo el límite más 1 byte
    Y no hay huecos entre rangos
    Y el primer rango empieza en 0 y el último termina en la duración total

  Escenario: 4. Dos chunks con 2 s de solape y texto equivalente → el merge no duplica
    Dado un primer chunk con "Uno, dos." de 0 a 2000 y "¿Cómo estás, amigo?" de 2000 a 5000
    Y un segundo chunk en tiempos absolutos con "¡Como estas amigo!" de 3000 a 6000
    Y "Yo bien." de 6000 a 8000
    Cuando se llama a mergeTranscripts
    Entonces el texto equivalente aparece una sola vez con sus tiempos originales
    Y "Yo bien." de 6000 a 8000 se conserva

  Escenario: 5. Una repetición legítima en tiempos distintos → se conserva
    Dado un primer chunk con "Adiós" de 0 a 3000
    Y un segundo chunk con "Adiós" de 10000 a 13000
    Cuando se llama a mergeTranscripts
    Entonces los dos segmentos "Adiós" están en el resultado
    Y el segundo mantiene startMs 10000
