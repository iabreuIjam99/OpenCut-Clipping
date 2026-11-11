# language: es
#
# Validación de cortes (Task 15).
# Cada escenario tiene tests Vitest cuyo nombre se cita aquí.
#
# Correspondencia:
#   1. Un corte de 15 s y otro de 180 s son válidos; 14 999 ms y 180 001 ms se descartan
#      → it("acepta 15_000 y 180_000, descarta 14_999 y 180_001")
#   2. Rango inválido (start < 0, start === end, end > durationMs) se descarta
#      → it("descarta start < 0, start === end, end > durationMs")
#   3. Los solapes se eliminan conservando el de mayor score; cortes contiguos se aceptan
#      → it("remueve solapes conservando mayor score")
#      → it("mantiene cortes no superpuestos")
#   4. La salida se ordena por startMs y se limita a 20 cortes
#      → it("capa a 20 cortes máximo")
#   5. Un título vacío, con <script>, con caracteres de control o de más de 80 code points se descarta
#      → it("descarta título vacío, >80 codepoints, con <>, con caracteres de control")
#   6. Duplicados con IoU > 0,8 (y cualquier solape) se colapsan conservando el mayor score
#      → it("colapsa duplicados IoU > 0.8 conservando mayor score")
#      → it("colapsa dos cortes con IoU exactamente 0.8 porque se solapan")
#   7. Entrada hostil (null, 42, "x", [], {cuts: "x"}, getter que lanza) devuelve [] sin lanzar
#      → it("devuelve [] para entradas hostiles sin lanzar")
#   8. Determinismo: la misma entrada dos veces produce exactamente la misma salida (mismos ids)
#      → it("mismo input produce misma salida")

Característica: Validador de cortes de video local-first
  Como operador del sistema de clipping
  Quiero validar los cortes producidos por el LM antes de devolverlos al cliente
  Para asegurar que solo datos validados y sanitizados salen al producto

  Escenario: Cortes en rangos válidos y duración correcta
    Dado un medio de 15_000 ms y 180_000 ms
    Cuando un corte tiene duración de 15_000 ms o 180_000 ms
    Entonces el corte es válido
    Y un corte de 14_999 ms se descarta
    Y un corte de 180_001 ms se descarta

  Escenario: Rango inválido se descarta
    Dado un medio con duración suficiente
    Cuando un corte tiene start < 0, start === end, o end > durationMs
    Entonces el corte se descarta

  Escenario: Solapes se eliminan conservando mayor score
    Dado dos cortes superpuestos con diferentes scores
    Cuando se validan
    Entonces se conserva el de mayor score
    Y el de menor score se descarta

  Escenario: Salida ordenada y limitada a 20
    Dado 21 cortes válidos
    Cuando se validan
    Entonces la salida tiene como máximo 20 cortes
    Y están ordenados por startMs de forma ascendente

  Escenario: Validación de título
    Dado un corte con título vacío, >80 codepoints, con <>, con caracteres de control
    Cuando se valida
    Entonces el corte se descarta

  Escenario: Duplicados con IoU > 0,8
    Dado dos cortes idénticos con diferentes scores
    Cuando se validan
    Entonces se conserva el de mayor score

  Escenario: Entrada hostil no lanza
    Dado entrada nula, número, string, u objeto inválido
    Cuando se valida
    Entonces se retorna [] sin lanzar

  Escenario: Determinismo
    Dada la misma entrada dos veces
    Cuando se validan
    Entonces la salida es exactamente la misma
    Y los ids son idénticos