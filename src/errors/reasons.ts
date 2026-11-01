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
  ["query.invalid-duration", "a duration in the query cannot be read"],
  ["query.invalid-size", "a size in the query cannot be read"],
  ["query.invalid-reference", "a reference in the query is not valid"],
  ["query.invalid-tag", "a tag in the query is not valid"],
  ["query.invalid-topic", "a topic in the query is not valid"],
  ["query.topic-scope", "a topic needs its chat in the query"],
].map(([reason, message]) => validation(reason as string, message as string))

const SIGN_IN: Entry[] = [
  ["oauth.declined", "authentication_error", "the provider's consent was declined"],
  ["oauth.timeout", "timeout", "the sign-in was not finished in time"],
  ["oauth.mismatch", "authentication_error", "the pasted sign-in result belongs to another sign-in"],
  ["oauth.missing", "authentication_error", "this profile is not signed in"],
  ["oauth.locked", "provider_unavailable", "another process holds this sign-in's lock"],
  ["oauth.no-response", "outcome_unknown", "the token request did not finish"],
  ["oauth.unavailable", "provider_unavailable", "the provider's token endpoint is unavailable"],
  ["oauth.expired", "authentication_error", "the provider refused the saved sign-in; sign in again"],
  ["oauth.invalid-response", "invalid_response", "the provider's token response could not be used"],
  ["oauth.failed", "authentication_error", "the provider returned no offline refresh token"],
  ["oauth.revoke-failed", "outcome_unknown", "the provider did not confirm the revoke"],
  ["oauth.invalid", "authentication_error", "the saved sign-in cannot be read"],
  ["oauth.not-saved", "configuration_error", "the sign-in cannot be saved or read where it is kept"],
]

const OTHERS: Entry[] = [
  ["model.offline", "permission_error", "downloading a model needs the network; --offline was requested"],
  [
    "contract.unacknowledged-override",
    "configuration_error",
    "a shared command contract changed without an explicit override",
  ],
  validation("context.read-budget", "the selected context reads exceed their text or request allowance"),
  validation("meeting-findings.stale", "meeting findings changed since they were read; stage a new batch"),
  validation("meeting-findings.dedicated-review", "review meeting findings through the dedicated findings command"),
  validation("evidence-findings.stale", "evidence findings changed since they were read; stage a new batch"),
  validation("evidence-findings.dedicated-review", "review evidence findings through the dedicated findings command"),
  validation("document.changed", "the document changed while it was read; nothing was saved"),
  ["document.not-imported", "not_found", "the document is not imported in this source account"],
  ["extraction.invalid-proposals", "invalid_response", "the model's memory proposals could not be used"],
  validation("extraction.text-too-long", "the text is too long for memory extraction"),
  validation("file.locked", "another process holds the file's lock"),
  ["mail.source-failed", "provider_error", "the mail server refused or did not complete a request"],
  ["mirror.partial", "provider_error", "some mirrored files were not synced"],
  ["profile.wrong-account", "authentication_error", "the signed-in source account does not match this profile"],
  validation("push.too-many-files", "the folder holds more files than one push takes"),
  validation("push.unreadable", "the folder to push could not be read"),
  validation("spreadsheet.unreadable", "the workbook could not be read"),
  ["state.invalid", "configuration_error", "the saved sync state is unreadable or invalid; it is kept, not reset"],
  ["sync.partial", "provider_error", "some calendars did not sync; the next sync retries them"],
  validation("event.conflict", "the event changed at the provider since the last sync; sync and try again"),
  validation("event.notify-required", "the event has other attendees; say whether to notify them"),
  validation("event.repeat-invalid", "the repeat rule is outside the RFC 5545 subset the calendars take"),
  validation("event.repeat-kind", "the series' rule holds a date or a time of the kind the event is leaving"),
  validation("event.repeat-split", "the series cannot be split at this occurrence, or was split there already"),
  validation("event.repeat-count", "a COUNT series is split only with a rule for its new part"),
  validation("event.unmovable", "the provider keeps this kind of event on its calendar"),
  ["calendar.read-only", "permission_error", "the calendar takes no new events from this account"],
  ["busy.offline", "permission_error", "calendars busy asks the provider; --offline was given"],
  validation("busy.no-calendars", "no calendar syncs and no person was named, so there is nobody to ask"),
  ["search.offline", "permission_error", "search --backend server asks the provider; --offline was given"],
  validation("search.no-calendars", "no calendar of this profile syncs yet, so the provider has nothing to search"),
  validation("search.server-options", "search --backend server takes neither --exact, --cursor nor --newest"),
  validation("search.one-backend", "search answers from one backend at a time: archive or server"),
  ["search.server-not-allowed", "permission_error", "the profile does not allow messages.server-search"],
  validation("search.server-no-criteria", "the query has nothing the server can search, so only the store is read"),
  ["search.server-unsupported", "provider_error", "this source's server cannot search"],
  ["search.server-rate-limited", "rate_limited", "the server refused a search as too many requests"],
  ["search.server-failed", "provider_unavailable", "the server did not answer a search"],
  ["search.server-timeout", "timeout", "the server did not answer within --server-time"],
  ["search.server-capped", "outcome_unknown", "the server found more than one search reads, or a branch was not sent"],
  validation("store.refused", "the local store refused the document text"),
  ["store.not-writable", "permission_error", "the message store cannot be written from this process"],
  [
    "store.vector-extension-missing",
    "configuration_error",
    "the install has no sqlite-vec extension for this platform; reinstall the CLI",
  ],
  ["store.vector-extension-failed", "configuration_error", "the sqlite-vec extension did not load; reinstall the CLI"],
  validation("store.vector-invalid", "a vector to store had a non-finite value"),
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
  ["person.no-owner", "not_found", "no person is marked as the owner in the store"],
  ["transcription.no-key", "authentication_error", "no OpenAI key is set for transcription"],
  validation("transcription.too-large", "the audio is over the transcription provider's size limit"),
  [
    "transcription.quota-exhausted",
    "permission_error",
    "the transcription provider account has no credit or limit left",
  ],
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
  validation("search.kind", "the saved search belongs to another kind of search: messages or meetings"),
  ["selection.out-of-scope", "permission_error", "the selection reaches outside what this profile may read"],
  validation("stemmer.invalid", "the stemmer is not valid for that script"),
  validation("stemmer.newer", "the stems were built by a newer tool"),
  validation("stemmer.unknown", "the store asks for stemmers this tool does not know"),
  validation("tag-review.over-budget", "the tag review is over its budget"),
  validation("tag-review.required", "the tag needs the owner's review first"),
  ["tag-review.stale", "configuration_error", "the tag review changed meanwhile"],
  validation("tag.invalid", "the tag is not valid"),
  ["reactions.list-hidden", "permission_error", "the chat does not let its members see who reacted"],
  ["reactions.broadcast", "permission_error", "a channel does not show who reacted to its posts"],
  validation("task.category-unknown", "the category is not in the task category list"),
  validation("task.claimed", "someone else holds the task"),
  validation("task.closed", "the task is already closed"),
  ["task.stale", "configuration_error", "the task changed since it was read; read it again"],
  validation("task.column", "the task beside which it moves is in another column than the status asked for"),
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

export const INPUT_FIELD_REASONS: ErrorReason[] = defineReasons([
  {
    reason: "input.field-conflict",
    code: "validation_error",
    message: "the input fields conflict",
    details: ["fields"],
  },
  {
    reason: "input.field-unsupported",
    code: "validation_error",
    message: "the input field is not supported",
    details: ["fields"],
  },
])

/** Every reason this package raises; cli-base's own are known to the handler already. */
export const REASONS: ErrorReason[] = defineReasons([
  ...QUERY_REASONS,
  ...INPUT_FIELD_REASONS,
  ...[...QUERY, ...SIGN_IN, ...OTHERS].map(([reason, code, message]) => ({
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
  "contracts",
  "calendars",
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
  "retry_after_ms",
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
