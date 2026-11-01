import { CliError } from "@wirecat/cli-base"

/** Quarters of [0, 1], lowest first; a person reads the label, a board column is ordered by the number. */
export const PRIORITY_LABELS = ["low", "medium", "high", "critical"] as const
export type PriorityLabel = (typeof PRIORITY_LABELS)[number]

/** The number a label is given: the middle of its quarter, so a move leaves room on either side. */
const MIDDLE: Readonly<Record<PriorityLabel, number>> = { low: 0.125, medium: 0.375, high: 0.625, critical: 0.875 }

/** The scores of the old 0 (urgent) … 4 (low), as store version 41 converted them. */
export const LEGACY_PRIORITY_SCORES = [0.875, 0.625, 0.375, 0.1875, 0.0625] as const

export const priorityLabel = (score: number | null): PriorityLabel | null =>
  score === null ? null : (PRIORITY_LABELS[Math.min(3, Math.max(0, Math.floor(score * 4)))] as PriorityLabel)

export const priorityBand = (label: PriorityLabel): { from: number; to: number } => {
  const at = PRIORITY_LABELS.indexOf(label)
  return { from: at / 4, to: (at + 1) / 4 }
}

/** The 0–4 integer a build before store version 41 reads: critical 0 … low 3, the bottom of low 4. */
export const legacyPriority = (score: number | null): number | null =>
  score === null
    ? null
    : score < 0.125
      ? 4
      : 3 - (PRIORITY_LABELS.indexOf(priorityLabel(score) as PriorityLabel) as number)

export const checkedScore = (score: number): number => {
  if (!Number.isFinite(score) || score < 0 || score > 1)
    throw new CliError("validation_error", "a priority score is 0 to 1")
  return score
}

/**
 * A priority as typed: a label, or 0 (urgent) … 4 (low) as before, which keeps the meaning it had.
 * `none` clears it.
 */
export const priorityOf = (value: string): number | null => {
  const word = value.trim().toLowerCase()
  if (word === "none") return null
  if ((PRIORITY_LABELS as readonly string[]).includes(word)) return MIDDLE[word as PriorityLabel]
  if (/^[0-4]$/.test(word)) return LEGACY_PRIORITY_SCORES[Number(word)] as number
  // A bare 0 or 1 is the old scale, where they mean the opposite; the decimal point says a 0–1 score is meant.
  if (/^(0?\.\d+|[01]\.\d*)$/.test(word) && Number(word) <= 1) return Number(word)
  throw new CliError(
    "validation_error",
    `a priority is ${PRIORITY_LABELS.join(", ")}, none, or a score from 0.0 to 1.0 with its decimal point; ` +
      "0 (urgent) … 4 (low) still work as critical, high, medium, low, low",
  )
}

/** `priorityOf` for a command-line option: Commander stores a parser's `null` as an empty string, so `none` stays a word. */
export const priorityOption = (value: string): number | "none" => priorityOf(value) ?? "none"
