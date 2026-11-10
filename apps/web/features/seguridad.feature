# language: es
#
# Fuente de verdad BDD del almacenamiento BYOK y la degradación local (Task 14a).
# No se ejecuta con Cucumber: cada escenario tiene un test Vitest 1:1 cuyo
# nombre cita el escenario (mismo patrón que `transcripcion.feature`).
#
# Correspondencia:
#   1. La clave se guarda en sessionStorage y no en localStorage.
#      → it("Scenario: La clave se guarda en sessionStorage y no en localStorage")
#   2. Una clave vacía o con caracteres de control se rechaza sin persistir.
#      → it("Scenario: Una clave vacía o con caracteres de control se rechaza sin persistir")
#   3. Sin sessionStorage (SSR o modo privado que lanza), el error es genérico y no contiene la clave.
#      → it("Scenario: Sin sessionStorage (SSR o modo privado que lanza), el error es genérico y no contiene la clave")
#   4. Borrar la clave es idempotente y deja hasProviderKey() en false.
#      → it("Scenario: Borrar la clave es idempotente y deja hasProviderKey() en false")
#   5. Un 429 del proxy propone el modo local (fallbackToLocal: true); un 401 no.
#      → it("Scenario: Un 429 del proxy propone el modo local (fallbackToLocal: true); un 401 no")
#
# Las pruebas adicionales de `byok.test.ts`, `byok.ssr.test.ts` y
# `cloud-errors.test.ts` (trim, 512/513 caracteres, setItem que lanza,
# clear idempotente con removeItem fallando, getItem que falla, códigos de
# payload desconocidos, entrada basura, pureza de `toCloudFailure`) cubren
# ramas internas y no corresponden a un escenario de este fichero.

Característica: Almacenamiento BYOK en sessionStorage y contrato de degradación local
  Como usuario de MonetizaClip
  Quiero guardar la clave de proveedor solo en sessionStorage, que muere al
  cerrar la pestaña
  Para que nunca se filtre a localStorage, logs, analytics ni la URL

  Escenario: 1. La clave se guarda en sessionStorage y no en localStorage
    Dado una clave de proveedor válida
    Cuando se llama a setProviderKey con la clave
    Entonces la clave persiste en sessionStorage
    Y no aparece en localStorage

  Escenario: 2. Una clave vacía o con caracteres de control se rechaza sin persistir
    Dado una clave vacía tras recortar o con caracteres de control (`\n`, `\r`, `\u0000`)
    Cuando se llama a setProviderKey con la clave
    Entonces se rechaza con ProviderKeyError y código INVALID_KEY
    Y no se persiste nada en sessionStorage

  Escenario: 3. Sin sessionStorage (SSR o modo privado que lanza), el error es genérico y no contiene la clave
    Dado una clave de proveedor válida
    Y sin `window` (SSR) o un `sessionStorage` cuyo `setItem` lanza (modo privado)
    Cuando se llama a setProviderKey con la clave
    Entonces se rechaza con ProviderKeyError y código STORAGE_UNAVAILABLE
    Y el mensaje es genérico en español y no contiene la clave

  Escenario: 4. Borrar la clave es idempotente y deja hasProviderKey() en false
    Dado una clave guardada en sessionStorage
    Cuando se llama a clearProviderKey dos veces
    Entonces no lanza en ninguna llamada
    Y hasProviderKey() devuelve false

  Escenario: 5. Un 429 del proxy propone el modo local (fallbackToLocal: true); un 401 no
    Dado un error del proxy con status 429
    Cuando se llama a toCloudFailure con el status
    Entonces fallbackToLocal es true y el mensaje invita a usar el modo local
    Y un status 401 devuelve fallbackToLocal false sin modo local
