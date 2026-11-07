/**
 * Cabeceras de seguridad (CSP) para el Worker de TanStack Start.
 *
 * `buildContentSecurityPolicy` es pura y fácil de testear.
 * `withSecurityHeaders` devuelve una `Response` nueva con la cabecera añadida
 * (no muta la original).
 * `injectNonceIntoHtml` añade `nonce="…"` a los `<script>` en línea del HTML.
 *
 * Notas de política (R2/R3):
 * - `script-src` nunca incluye `'unsafe-inline'`. Se inspeccionó el HTML
 *   servido y SÍ contiene `<script>` en línea (bootstrap de streaming de
 *   TanStack Start: `data-tsr-stream-part` y el boundary script). Por tanto
 *   `script-src` lleva `'self' 'nonce-<valor>'` con un nonce generado por
 *   request, y ese mismo nonce se inyecta en los scripts en línea (ver
 *   `src/start.ts`). Nunca se usa `'unsafe-inline'` para scripts.
 * - `style-src` mantiene `'unsafe-inline'`: Tailwind v4 y los estilos en
 *   línea de los componentes lo exigen.
 * - `connect-src` añade `ws: wss:` solo en dev (HMR de Vite).
 *
 * Nonce (F1): siempre base64 de 16 bytes aleatorios (128 bits). Un valor hex
 * no es un nonce-source válido para CSP y los navegadores lo rechazarían.
 */

/**
 * Intento de nonce nativo del framework (F2):
 * 1. `router.options.ssr = { nonce }` es un tipo soportado
 *    (`@tanstack/router-core/dist/esm/router.d.ts:371-373`).
 * 2. `renderRouterToStream` lo pasa a `ReactDOMServer.renderTo{Readable,Pipeable}Stream({ nonce })`.
 * 3. `headContentUtils` emite `<meta property="csp-nonce">` a partir de
 *    `router.options.ssr?.nonce`; `ScriptOnce`/`HeadContent`/`Scripts` lo aplican.
 * 4. `start-server-core/dist/esm/request-handler.d.ts:3` declara
 *    `BaseContext = { nonce?: string }`.
 *
 * Sin embargo, no cabe cablearlo en esta versión:
 * - `createStartHandler.js` nunca copia `context.nonce` →
 *   `router.options.ssr.nonce` (no hay `router.update({ ssr: { nonce } })`).
 * - El middleware se ejecuta alrededor de `next()`, y el router solo se crea
 *   dentro de `next()`/`executeRouter`, por lo que el middleware no tiene el
 *   router disponible antes del render.
 * - Los `<script>` en línea que hay que proteger son los scripts de
 *   bootstrap de streaming de TanStack Start (`data-tsr-stream-part`,
 *   boundary), inyectados por el envoltorio del stream de Start, NO por React,
 *   por lo que el `nonce` de React no los tocaría.
 *
 * Conclusión: se conserva el camino de búfer sobre HTML (narrowed, ver
 * `injectNonceIntoHtml`). Seguimiento explícito para Task 21: medir el
 * coste de CPU/memoria de `response.text()` en páginas grandes (el Workers
 * platform tiene un presupuesto de ~10 ms CPU por request) y, si procede,
 * migrar a nonce nativo o a un `TransformStream` que no búfertee el cuerpo.
 */

export interface ContentSecurityPolicyOptions {
  dev: boolean
  nonce?: string
}

export function buildContentSecurityPolicy(options: ContentSecurityPolicyOptions): string {
  const { dev, nonce } = options
  const scriptSrc = nonce ? `'self' 'nonce-${nonce}'` : `'self'`
  const devWs = dev ? " ws: wss:" : ""

  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    `connect-src 'self'${devWs}`,
  ].join("; ")
}

export function withSecurityHeaders(response: Response, csp: string): Response {
  const headers = new Headers(response.headers)
  headers.set("Content-Security-Policy", csp)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * Genera un nonce por request en formato base64 (16 bytes aleatorios = 128 bits).
 * base64 es el único formato válido como `nonce-source` en CSP; un valor hex
 * sería rechazado por el navegador y silenciaría la protección.
 */
export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes))
}

/**
 * Inyecta `nonce="…"` en los `<script>` en línea (sin `src`) del HTML para que
 * ejecuten bajo `script-src 'self' 'nonce-…'` (R3).
 *
 * Reglas de contención (F2/F6):
 * - Solo procesa `text/html`.
 * - Nunca añade nonce a `<script src="...">` ni a scripts que ya traen `nonce`.
 * - Si el cuerpo no cambia, devuelve la misma respuesta (sin nuevo búfer).
 * - Un literal `<script` dentro de un cadena (p. ej. JSON) no tiene `>`
 *   seguido, así que la expresión `<script\b([^>]*)>` no coincide y no se
 *   duplica el nonce.
 */
export async function injectNonceIntoHtml(response: Response, nonce: string): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("text/html")) return response

  const html = await response.text()
  const injected = html.replace(
    // Negative lookbehind: no contar un `<script` precedido de `"` `'` o `=`,
    // para no tratar como etiqueta un literal `<script` dentro de un valor
    // de atributo o cadena JSON (F6).
    /(?<!["'=])<script\b([^>]*)>/gi,
    (match, attrs) => {
      if (/\bsrc\s*=/i.test(attrs) || /\bnonce\s*=/i.test(attrs)) return match
      return `<script${attrs} nonce="${nonce}">`
    },
  )

  if (injected === html) return response
  const headers = new Headers(response.headers)
  return new Response(injected, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
