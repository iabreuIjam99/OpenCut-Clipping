/**
 * Shared transcript type for the segmentation pipeline (Task 11, ARCHITECTURE
 * §4.3 cloud mode).
 *
 * Times are ABSOLUTE milliseconds over the whole source: the cloud client adds
 * `AudioChunk.offsetMs` before calling {@link mergeTranscripts}, which never
 * re-offsets them.
 *
 * @module transcript
 */

export type TranscriptSegment = {
  /** Absolute start of the segment, in milliseconds. */
  startMs: number
  /** Absolute end of the segment, in milliseconds (exclusive). */
  endMs: number
  /** Raw text as the transcription service returned it (never normalized here). */
  text: string
}
