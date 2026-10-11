import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import { normalizeVocabularyName, vocabularySimilarity } from "../../domain/vocabulary.js"
import type { StoreContext } from "./open.js"

export interface TagCreationOptions {
  expectedCreationFingerprint?: string
}
export interface TagCreationReview {
  creationFingerprint: string
  candidates: { id: string; name: string; kind: "tag" | "topic"; similarity: number }[]
}

const folded = (name: string): string | null => {
  try {
    return normalizeVocabularyName(name)
  } catch {
    return null
  }
}

/** Includes both label kinds and aliases: a narrower preview must not hide a collision. */
export const tagCreationReview = (
  { database }: StoreContext,
  name: string,
  kind: "tag" | "topic",
): TagCreationReview => {
  const metadata = database
    .prepare("SELECT count(*) AS count,coalesce(sum(length(CAST(name AS BLOB))),0) AS bytes FROM tags")
    .get()
  const aliasMetadata = database
    .prepare(
      "SELECT count(*) AS count,coalesce(sum(length(CAST(a.name AS BLOB))),0) AS bytes FROM aliases a " +
        "JOIN tags t ON t.id=a.aliasable_id WHERE a.aliasable_type='tag' AND a.account_id IS NULL",
    )
    .get()
  if (
    Number(metadata?.count ?? 0) > 5000 ||
    Number(aliasMetadata?.count ?? 0) > 100000 ||
    Number(metadata?.bytes ?? 0) + Number(aliasMetadata?.bytes ?? 0) > 4 * 1024 * 1024
  )
    throw new CliError("validation_error", "label creation review exceeds its metadata budget", {
      reason: "tag_review_budget",
    })
  const rows = database.prepare("SELECT id,name,kind FROM tags ORDER BY id").all()
  const aliases = database
    .prepare(
      "SELECT a.id,a.aliasable_id,a.name FROM aliases a JOIN tags t ON t.id=a.aliasable_id " +
        "WHERE a.aliasable_type='tag' AND a.account_id IS NULL ORDER BY a.id",
    )
    .all()
  const names = new Map<number, string[]>()
  for (const alias of aliases) {
    const id = Number(alias.aliasable_id)
    const values = names.get(id) ?? []
    values.push(String(alias.name))
    names.set(id, values)
  }
  const candidates = rows
    .map((row) => ({
      id: String(row.id),
      name: String(row.name),
      kind: row.kind as "tag" | "topic",
      similarity: Math.max(
        ...[String(row.name), ...(names.get(Number(row.id)) ?? [])].map((value) =>
          folded(value) === null ? 0 : vocabularySimilarity(name, value),
        ),
      ),
    }))
    .filter((entry) => entry.similarity >= 0.65)
    .sort((a, b) => b.similarity - a.similarity || Number(a.id) - Number(b.id))
    .slice(0, 10)
  return {
    creationFingerprint: `label-v1:${createHash("sha256")
      .update(
        JSON.stringify({
          name: normalizeVocabularyName(name),
          kind,
          rows,
          aliases,
        }),
      )
      .digest("hex")}`,
    candidates,
  }
}

export const guardTagCreation = (
  context: StoreContext,
  name: string,
  kind: "tag" | "topic",
  by: "owner" | "agent",
  options: TagCreationOptions = {},
): void => {
  const expected = options.expectedCreationFingerprint
  if (expected !== undefined && (typeof expected !== "string" || !/^label-v1:[a-f0-9]{64}$/.test(expected)))
    throw new CliError("validation_error", "invalid label creation review fingerprint")
  if (expected !== undefined && by !== "owner")
    throw new CliError("permission_error", "only the owner can accept a distinct label after review")
  const review = tagCreationReview(context, name, kind)
  if (expected !== undefined && expected !== review.creationFingerprint)
    throw new CliError("configuration_error", "labels changed since the creation review", {
      reason: "stale_tag_review",
    })
  if (review.candidates.length && expected === undefined)
    throw new CliError(
      "validation_error",
      "similar labels exist; reuse one or review this distinct label before creation",
      {
        reason: "tag_review_required",
        ...review,
      },
    )
}
