import { UPSTREAM_URL } from "./config";

/**
 * Cabeceras hop-by-hop (RFC 9110 §7.6.1) + las que el runtime ya resuelve.
 * `content-length` se elimina a propósito: el cuerpo se reenvía como stream y el
 * upstream debe recibirlo con `Transfer-Encoding: chunked`, no con una longitud
 * declarada por el cliente (R6).
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "expect",
  "cf-connecting-ip",
  "cf-ray",
  "cf-visitor",
  "cf-ipcountry",
  "cdn-loop",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
]);

/**
 * Proxy de streaming puro: `request.body` (ReadableStream) se pasa a `fetch` sin
 * `await request.arrayBuffer()`, sin `await request.text()` y sin construir un
 * `new Response(request.body)` intermedio.
 */
export async function proxyStream(
  request: Request,
  upstreamUrl: string = UPSTREAM_URL,
): Promise<Response> {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set("x-proxy-spike", "1");

  const hasBody =
    request.method !== "GET" && request.method !== "HEAD" && request.body !== null;

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (hasBody) init.body = request.body;
  // El abort del cliente (desconexión) se propaga al fetch del upstream.
  init.signal = request.signal;

  const upstream = await fetch(upstreamUrl, init);

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k) || k === "content-encoding") return;
    responseHeaders.set(key, value);
  });
  // El cuerpo de la respuesta del sink no se toca: su content-length sigue siendo
  // válido y se copia tal cual (se documenta en RESULT.md).
  const contentLength = upstream.headers.get("content-length");
  if (contentLength !== null) responseHeaders.set("content-length", contentLength);
  responseHeaders.set("x-proxy-impl", "stream");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
