import type { ClipCandidate } from "./contracts"
import { MAX_CLIP_MS, MAX_CLIPS, MAX_IOU, MAX_TITLE_LENGTH, MIN_CLIP_MS } from "./contracts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function iou(a: ClipCandidate, b: ClipCandidate): number {
  const start = Math.max(a.startMs, b.startMs)
  const end = Math.min(a.endMs, b.endMs)
  if (start >= end) return 0
  const intersection = end - start
  const union = a.endMs - a.startMs + (b.endMs - b.startMs) - intersection
  return intersection / union
}

function overlaps(a: ClipCandidate, b: ClipCandidate): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs
}

function hasControlChars(title: string): boolean {
  for (let i = 0; i < title.length; i++) {
    const code = title.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function isValidTitle(title: string): boolean {
  if (title.length === 0) return false
  if (Array.from(title).length > MAX_TITLE_LENGTH) return false
  if (hasControlChars(title)) return false
  if (title.includes("<") || title.includes(">")) return false
  return true
}

function extractCuts(input: unknown): unknown[] | null {
  if (Array.isArray(input)) return input
  if (!isRecord(input)) return null
  const cuts = input.cuts
  return Array.isArray(cuts) ? cuts : null
}

function toCandidate(value: unknown, durationMs: number): ClipCandidate | null {
  if (!isRecord(value)) return null

  const startRaw = value.startMs
  const endRaw = value.endMs
  if (
    typeof startRaw !== "number" ||
    typeof endRaw !== "number" ||
    !Number.isFinite(startRaw) ||
    !Number.isFinite(endRaw)
  ) {
    return null
  }

  const startMs = Math.round(startRaw)
  const endMs = Math.round(endRaw)
  if (startMs < 0 || startMs >= endMs || endMs > durationMs) return null

  const clipDuration = endMs - startMs
  if (clipDuration < MIN_CLIP_MS || clipDuration > MAX_CLIP_MS) return null

  const titleRaw = value.title
  if (typeof titleRaw !== "string") return null
  const title = titleRaw.trim()
  if (!isValidTitle(title)) return null

  const scoreRaw = value.score
  if (typeof scoreRaw !== "number" || !Number.isFinite(scoreRaw)) return null
  const score = Math.min(1, Math.max(0, scoreRaw))

  return { id: `clip-${startMs}-${endMs}`, startMs, endMs, title, score }
}

/**
 * Valida y normaliza cortes provenientes de una fuente no confiable (LLM o
 * heurísticas). Es una frontera pura: nunca lanza, nunca muta la entrada y
 * descarta cualquier corte inválido. Devuelve como máximo `MAX_CLIPS` cortes,
 * sin solapes, ordenados por `startMs` ascendente e identificados de forma
 * determinista.
 */
export function validateCuts(input: unknown, media: { durationMs: number }): ClipCandidate[] {
  try {
    const durationRaw: unknown = media.durationMs
    if (
      typeof durationRaw !== "number" ||
      !Number.isFinite(durationRaw) ||
      durationRaw < MIN_CLIP_MS
    ) {
      return []
    }

    const cuts = extractCuts(input)
    if (cuts === null) return []

    const candidates: ClipCandidate[] = []
    for (const cut of cuts) {
      const candidate = toCandidate(cut, durationRaw)
      if (candidate !== null) candidates.push(candidate)
    }

    // Mayor score primero; empate, el corte que empieza antes. Un corte se
    // acepta solo si no se solapa con ninguno ya aceptado, lo que también
    // descarta duplicados (IoU > MAX_IOU) y garantiza la invariante de "sin
    // solapes" incluso cuando un corte choca con varios aceptados.
    const ranked = candidates.slice().sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.startMs - b.startMs
    })

    const accepted: ClipCandidate[] = []
    for (const candidate of ranked) {
      if (accepted.length >= MAX_CLIPS) break
      const conflicts = accepted.some(
        (existing) => iou(candidate, existing) > MAX_IOU || overlaps(candidate, existing),
      )
      if (!conflicts) accepted.push(candidate)
    }

    return accepted.sort((a, b) => a.startMs - b.startMs)
  } catch {
    return []
  }
}
