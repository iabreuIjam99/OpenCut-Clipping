/**
 * Quema CPU de JS de forma controlada para calibrar el profiler CDP.
 * No participa en las tablas de `/proxy`: sirve para medir el intervalo real
 * entre muestras del sampler de workerd y validar que el método detecta CPU.
 */
export function burnCpu(ms: number): string {
  const end = Date.now() + Math.max(0, ms);
  let accumulator = 0;
  while (Date.now() < end) {
    for (let i = 0; i < 10_000; i++) accumulator += Math.sqrt(i);
  }
  return String(accumulator);
}

export function burnMsFrom(request: Request): number {
  const raw = new URL(request.url).searchParams.get("ms") ?? "10";
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10;
}
