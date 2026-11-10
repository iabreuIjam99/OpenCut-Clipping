# language: es
#
# Fuente de verdad BDD de la cuota diaria y Turnstile (Task 14b).
# No se ejecuta con Cucumber: cada escenario tiene tests Vitest cuyo nombre se
# cita aquí (mismo patrón que `apps/web/features/seguridad.feature`).
#
# Correspondencia:
#   1. La cuota permite hasta el límite y bloquea al superarlo
#      → it("permite hasta el límite")
#      → it("bloquea por encima del límite")            (quota.test.ts)
#   2. El día de cuota es UTC y el hash de IP nunca expone la IP
#      → it("usa el día UTC")
#      → it("devuelve 64 hex y no contiene la IP")      (quota.test.ts)
#   3. Un token Turnstile ausente o inválido se rechaza sin consumir cuota
#      → it("turnstile false → 401 UNAUTHORIZED, quota store not called, fetch not called")
#      → it("devuelve false cuando token es null")      (turnstile.test.ts)
#   4. La cuota agotada responde 429 y propone el modo local
#      → it("turnstile true + cuota agotada → 429 QUOTA_EXCEEDED, fetch not called")
#      → it("turnstile false + cuota agotada → 401 (Turnstile va primero), store not called")
#   5. El éxito consume cuota una sola vez con hash hex-64 y no filtra el token a Groq
#      → it("éxito: hash hex-64 (no la IP), token Turnstile no viaja a Groq, Authorization sí")

Característica: Cuota diaria por IP hasheada y Turnstile en el proxy de transcripción
  Como operador del proxy de transcripción
  Quiero limitar el uso por IP hasheada y exigir Turnstile
  Para evitar abuso y mantener el coste controlado sin guardar IPs crudas

  Escenario: La cuota permite hasta el límite y bloquea al superarlo
    Dado un store que devuelve count=3
    Cuando se consume cuota con limit=3
    Entonces allowed es true y remaining es 0
    Y con count=4 y limit=3, allowed es false y remaining es 0

  Escenario: El día de cuota es UTC y el hash de IP nunca expone la IP
    Dado un reloj fijado a 2024-01-15T23:59:59Z
    Cuando se consume cuota
    Entonces el día enviado al store es 2024-01-15
    Y hashIp("salt", "1.2.3.4") devuelve 64 caracteres hex en minúsculas
    Y el hash no contiene la IP

  Escenario: Un token Turnstile ausente o inválido se rechaza sin consumir cuota
    Dado un verificador Turnstile que devuelve false
    Cuando llega una petición con x-provider-key y x-turnstile-token
    Entonces la respuesta es 401 UNAUTHORIZED con Cache-Control no-store
    Y no se consume cuota
    Y no se llama al proveedor

  Escenario: La cuota agotada responde 429 y propone el modo local
    Dado un Turnstile válido y un store que devuelve count=21
    Cuando se consume cuota con limit=20
    Entonces la respuesta es 429 QUOTA_EXCEEDED
    Y el mensaje sugiere usar el modo local
    Y no se llama al proveedor
    Y Turnstile se evalúa antes que la cuota (401 antes que 429)

  Escenario: El éxito consume cuota una sola vez con hash hex-64 y no filtra el token a Groq
    Dado un Turnstile válido y un store que devuelve count=1
    Cuando la petición llega con cf-connecting-ip
    Entonces la respuesta es 200 con los segmentos mapeados
    Y el store recibe exactamente una vez un hash de 64 hex, no la IP
    Y la cabecera x-turnstile-token no llega a Groq
    Y la cabecera Authorization sí llega a Groq
