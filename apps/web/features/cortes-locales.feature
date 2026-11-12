# language: es
#
# Heurísticas locales de corte (Task 16).
# No se ejecuta con Cucumber: cada escenario tiene un test Vitest 1:1 cuyo
# nombre cita el escenario (mismo patrón que `seguridad.feature`).
#
# Correspondencia:
#   1. Un transcript con preguntas y cifras produce cortes ordenados, sin solapes y con puntuación.
#      → it("Scenario: Un transcript con preguntas y cifras produce cortes ordenados, sin solapes y con puntuación")
#   2. Un brief con una keyword concentra el mejor score en la ventana que la contiene.
#      → it("Scenario: Un brief con una keyword concentra el mejor score en la ventana que la contiene")
#   3. Dos llamadas con la misma entrada devuelven exactamente el mismo resultado.
#      → it("Scenario: Dos llamadas con la misma entrada devuelven exactamente el mismo resultado")
#   4. Un transcript más corto que 15 s devuelve [].
#      → it("Scenario: Un transcript más corto que 15 s devuelve []")
#   5. Un transcript con huecos y segmentos basura (texto vacío, tiempos invertidos, NaN) no lanza y devuelve solo cortes válidos.
#      → it("Scenario: Un transcript con huecos y segmentos basura no lanza y devuelve solo cortes válidos")
#   6. Un título con <script> y caracteres de control se sanea y nunca supera 80 code points.
#      → it("Scenario: Un título con <script> y caracteres de control se sanea y nunca supera 80 code points")

Característica: Heurísticas locales de corte deterministas
  Como usuario de MonetizaClip
  Quiero análisis de cortes locales sin red, deterministas y sin solapes
  Para obtener clips de video con puntuación y título automático

  Escenario: Un transcript con preguntas y cifras produce cortes ordenados, sin solapes y con puntuación
    Dado un transcript con segmentos que contienen preguntas y cifras
    Cuando se llama a scoreWindows con un brief relacionado
    Entonces se devuelven cortes ordenados por startMs ascendente
    Y no hay solapes entre cortes consecutivos
    Y cada corte tiene un score finito en [0,1]
    Y los títulos son texto plano sin caracteres de control

  Escenario: Un brief con una keyword concentra el mejor score en la ventana que la contiene
    Dado un transcript con mención de una palabra clave
    Cuando se llama a scoreWindows con ese brief
    Entonces la ventana que contiene la keyword tiene el score más alto
    Y los scores reflejan la presencia de preguntas, cifras y keywords

  Escenario: Dos llamadas con la misma entrada devuelven exactamente el mismo resultado
    Dado un transcript y un brief concretos
    Cuando se llama dos veces seguidas a scoreWindows
    Entonces el resultado es idéntico (deep-equal), incluyendo el orden y los scores
    Y el determinismo se mantiene aunque el input venga reordenado

  Escenario: Un transcript más corto que 15 s devuelve []
    Dado un transcript con duración total < MIN_CLIP_MS
    Cuando se llama a scoreWindows
    Entonces se devuelve [] (array vacío)
    Y no se lanza ningún error

  Escenario: Un transcript con huecos y segmentos basura no lanza y devuelve solo cortes válidos
    Dado un transcript con segmentos basura (texto vacío, tiempos invertidos, NaN)
    Cuando se llama a scoreWindows
    Entonces la función never throws (retorna [] en catch)
    Y solo se consideran segmentos válidos con tiempos consistentes

  Escenario: Un título con <script> y caracteres de control se sanea y nunca supera 80 code points
    Dado un transcript cuyo primer segmento tiene texto con <script> y control chars
    Cuando se genera el título para un clip
    Entonces el título no contiene < ni >
    Y no hay caracteres de control (códigos < 0x20 ni 0x7f)
    Y la longitud en code points es como máximo 80
    Y si el título quedaría vacío, se usa el fallback mm:ss