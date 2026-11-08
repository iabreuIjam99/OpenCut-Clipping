/**
 * Destino del proxy. Es un sink LOCAL (scripts/sink.ts) que corre en el host.
 * El spike NO llama a Groq: no hay clave y no debe haberla en el repo.
 */
export const UPSTREAM_URL = "http://127.0.0.1:8798/sink";

export interface ProxyEnv {
  UPSTREAM?: string;
}
