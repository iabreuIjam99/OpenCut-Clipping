import { createMiddleware, createStart } from "@tanstack/start-client-core"
import {
  buildContentSecurityPolicy,
  generateNonce,
  injectNonceIntoHtml,
  withSecurityHeaders,
} from "./lib/security-headers"

/**
 * Middleware de request que añade la cabecera `Content-Security-Policy` y, en
 * respuestas HTML, inyecta un nonce por request en los `<script>` en línea para
 * que ejecuten bajo `script-src 'self' 'nonce-…'` (nunca `'unsafe-inline'`,
 * R3).
 *
 * Alcance real (F3): envuelve `next()` de la cadena de request-middlewares, por
 * lo que cubre las respuestas que produce la cadena (páginas renderizadas por
 * el router, incluidas sus 404, y respuestas de serverFn). Las excepciones no
 * capturadas que se convierten en 500 se lanzan fuera de la cadena en
 * `createStartHandler`, por tanto esos 500 no pasan por este middleware y no se
 * les garantiza la cabecera. El middleware nunca lanza: siempre devuelve una
 * respuesta.
 *
 * Si una ruta u otro middleware ya estableció `Content-Security-Policy`, se
 * respeta y no se vuelve a procesar (conservador, F2c).
 *
 * Registrado como `requestMiddleware` global de `createStart` (R1).
 */
const cspMiddleware = createMiddleware().server(async ({ next }) => {
  const result = await next()

  // Si el contenido ya trae CSP (otro middleware o ruta), no se duplica.
  if (result.response.headers.has("content-security-policy")) return result

  const nonce = generateNonce()
  const csp = buildContentSecurityPolicy({ dev: import.meta.env.DEV, nonce })
  let response = withSecurityHeaders(result.response, csp)
  response = await injectNonceIntoHtml(response, nonce)
  return { ...result, response }
})

export const startInstance = createStart(() => ({
  requestMiddleware: [cspMiddleware],
}))
