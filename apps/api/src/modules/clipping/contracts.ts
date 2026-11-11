export type ClipCandidate = {
  id: string
  startMs: number
  endMs: number
  title: string
  score: number
}

export type TranscriptSegment = {
  startMs: number
  endMs: number
  text: string
}

export const MIN_CLIP_MS = 15_000
export const MAX_CLIP_MS = 180_000
export const MAX_CLIPS = 20
export const MAX_TITLE_LENGTH = 80
export const MAX_IOU = 0.8

export const SNAP_MS = 750
