import type { FailureContext } from "@wirecat/cli-base"
import { QUERY_REASONS } from "@wirecat/cli-base/query"
import type { ErrorReason } from "@wirecat/cli-base/standards"
import { defineReasons } from "@wirecat/cli-base/standards"

type Entry = [reason: string, code: ErrorReason["code"], message: string]

const validation = (reason: string, message: string): Entry => [reason, "validation_error", message]

/** The query reasons only message search raises; the shared ones are cli-base's `QUERY_REASONS`. */
const QUERY: Entry[] = [
  ["query.aborted", "the search was stopped before it finished"],
  ["query.conflict", "two parts of the query contradict each other"],
  ["query.invalid-context", "the context size is out of range"],
  ["query.invalid-limit", "the limit is out of range"],
  ["query.invalid-scope", "the query selects no account"],
  ["query.invalid-size", "a size in the query cannot be read"],
  ["query.invalid-reference", "a reference in the query is not valid"],
  ["query.invalid-tag", "a tag in the query is not valid"],
  ["query.invalid-topic", "a topic in the query is not valid"],
  ["query.topic-scope", "a topic needs its chat in the query"],
].map(([reason, message]) => validation(reason as string, message as string))

const OTHERS: Entry[] = [
  validation("context.read-budget", "the selected context reads exceed their text or request allowance"),
  validation("meeting-findings.stale", "meeting findings changed since they were read; stage a new batch"),
  validation("meeting-findings.dedicated-review", "review meeting findings through the dedicated findings command"),
  validation("document.changed", "the document changed while it was read; nothing was saved"),
  ["document.not-imported", "not_found", "the document is not imported in this source account"],
  ["extraction.invalid-proposals", "invalid_response", "the model's memory proposals could not be used"],
  validation("extraction.text-too-long", "the text is too long for memory extraction"),
  validation("file.locked", "another process holds the file's lock"),
  ["profile.wrong-account", "authentication_error", "the signed-in source account does not match this profile"],
  validation("store.refused", "the local store refused the document text"),
  validation("catalog.scope-limit", "the selected catalog exceeds its entry limit"),
  validation("evidence.row-too-large", "one evidence row is over its size limit"),
  validation("index.not-ready", "the search index is still being built"),
  validation("input.closed", "the input closed before the answer"),
  validation("input.required", "the command needs an answer and cannot ask for one"),
  validation("input.too-large", "the input is over its size limit"),
  ["meeting-project.stale", "configuration_error", "the meeting's project changed meanwhile"],
  validation("memory.evidence-required", "a memory needs its evidence"),
  validation("memory.scope-required", "a memory needs its scope"),
  ["model.not-downloaded", "not_found", "the model is not downloaded on this machine"],
  validation("name.invalid", "the name is not valid"),
  validation("output.choose-fields", "at a terminal, --json names the fields it prints"),
  validation("output.one-object", "a report is one JSON object; --jsonl streams lists only"),
  validation("output.unknown-field", "the answer has no field by that name"),
  validation("name.taken", "the name is already used"),
  validation("period.ambiguous", "the period can be read more than one way"),
  validation("proposal.wrong-state", "the proposal is not in a state that allows this"),
  validation("ranking.invalid", "the ranking is not valid"),
  validation("selection.changed", "the stored selection changed meanwhile"),
  validation("selection.invalid", "the selection is not valid"),
  ["selection.out-of-scope", "permission_error", "the selection reaches outside what this profile may read"],
  validation("stemmer.invalid", "the stemmer is not valid for that script"),
  validation("stemmer.newer", "the stems were built by a newer tool"),
  validation("stemmer.unknown", "the store asks for stemmers this tool does not know"),
  validation("tag-review.over-budget", "the tag review is over its budget"),
  validation("tag-review.required", "the tag needs the owner's review first"),
  ["tag-review.stale", "configuration_error", "the tag review changed meanwhile"],
  validation("tag.invalid", "the tag is not valid"),
  validation("task.category-unknown", "the category is not in the task category list"),
  validation("task.claimed", "someone else holds the task"),
  validation("task.closed", "the task is already closed"),
  validation("task.dependency-cycle", "the task would depend on itself"),
  validation("task.duplicate-candidates", "open tasks may be the same job: attach to one, or add it as new"),
  validation("task.certainty-required", "an agent closes a task with its certainty, 0 to 1"),
  ["task.pair-decided", "permission_error", "the owner already decided the pair; an agent does not change it"],
  validation("task.no-close-suggestion", "the task has no agent's close waiting on the owner"),
  validation("task.merged", "the task was merged into another; use that one"),
  validation("task.not-merged", "the task was not merged into another"),
  ["upgrade.install-failed", "provider_error", "the installer failed; the old version stays"],
  ["topic.owner-only", "permission_error", "only the owner may use this topic"],
  ["vocabulary.alias-conflict", "configuration_error", "two vocabulary entries claim one alias"],
  validation("vocabulary.consolidation-over-budget", "the selected tag dependencies exceed the preview budget"),
  validation("vocabulary.over-byte-budget", "the vocabulary is over its size budget"),
  validation("vocabulary.over-entry-budget", "the vocabulary has too many entries"),
  ["vocabulary.stale", "configuration_error", "the vocabulary changed meanwhile"],
]

/** Every reason this package raises; cli-base's own are known to the handler already. */
export const REASONS: ErrorReason[] = defineReasons([
  ...QUERY_REASONS,
  ...[...QUERY, ...OTHERS].map(([reason, code, message]) => ({
    reason,
    code,
    message,
    details: reason === "vocabulary.consolidation-over-budget" ? ["table"] : [],
  })),
])

/**
 * Detail keys an error from this package may carry, until each is registered on its own reason. Not `cause`:
 * that can hold a provider's or SQLite's raw text.
 */
export const DETAILS = [
  "allowed",
  "alternative",
  "arguments",
  "at",
  "available",
  "batch",
  "budget",
  "built",
  "candidates",
  "chat",
  "chat_id",
  "cli",
  "complete",
  "emitted_bytes",
  "exact",
  "forum",
  "guide",
  "hint",
  "id",
  "index",
  "kind",
  "limit",
  "limit_source",
  "max_bytes",
  "model",
  "name",
  "operation_id",
  "operation_ids",
  "text_limit",
  "store_refused_in",
  "partial_output",
  "path",
  "permission",
  "person_ids",
  "previous_chat_id",
  "profiles",
  "provider_error",
  "provider",
  "recovery",
  "reference",
  "remembered",
  "retry_at",
  "runtime",
  "saved",
  "scheduled_for",
  "script",
  "sent",
  "sent_count",
  "settlement_failed",
  "span",
  "sqlite",
  "stage",
  "standing",
  "state",
  "stderr",
  "term",
  "total",
  "upgraded",
  "wanted",
] as const

/** What a CLI adds to the shared registry: its own reasons, and the detail keys its adapters raise. */
export interface AppErrors {
  reasons?: readonly ErrorReason[]
  details?: readonly string[]
}

const SHARED: FailureContext = { reasons: REASONS, details: DETAILS }
const merged = new WeakMap<AppErrors, FailureContext>()

/** The registry every error handler reads — the CLI's, MCP's and the meeting tools' — so none drops an app's keys. */
export const failureContext = (errors?: AppErrors): FailureContext => {
  if (!errors) return SHARED
  const known = merged.get(errors)
  if (known) return known
  const unnamed = (errors.details ?? []).filter((key) => !/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(key))
  if (unnamed.length > 0) throw new Error(`error details must be snake_case: ${unnamed.join(", ")}`)
  const context = {
    reasons: defineReasons([...REASONS, ...(errors.reasons ?? [])]),
    details: [...new Set([...DETAILS, ...(errors.details ?? [])])],
  }
  merged.set(errors, context)
  return context
}
