import { CliError, singleLine } from "@wirecat/cli-base"

export const TAG_TYPES = ["chat", "contact", "message", "task"] as const
export type TagType = (typeof TAG_TYPES)[number]

const TAG = /^[a-z0-9-]{1,32}$/

/** Lowercase, so `Work` and `work` are one tag; otherwise refused rather than rewritten into another word. */
export const tagOf = (value: string): string | undefined => {
  const tag = value.trim().toLowerCase()
  return TAG.test(tag) ? tag : undefined
}

export const normalizeTag = (value: string): string => {
  const tag = tagOf(value)
  if (tag === undefined)
    throw new CliError(
      "validation_error",
      `"${singleLine(value)}" is not a tag — use 1–32 letters a–z, digits and hyphens`,
      { reason: "tag.invalid" },
    )
  return tag
}
