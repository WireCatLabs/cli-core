import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import type { ChatCoverage } from "../services/chat-coverage.js"
import { dateWindow, momentOf } from "../services/moment.js"
import type { StoredProjectGathering } from "../services/stored-project-gathering.js"
import { coverageGaps } from "./messenger/search-answers.js"

/** Days back (`90d`) or a start date (`2026-09-01`); either way the run freezes its end, so a resume keeps it. */
export const projectWindowOf = (value: string): { days: number } | { after: number } => {
  const days = /^([1-9]\d{0,2})d$/.exec(value)?.[1]
  if (days !== undefined && Number(days) <= 730) return { days: Number(days) }
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(value))
    return { after: momentOf(value, "--since-time") }
  throw new CliError(
    "validation_error",
    `--since-time takes 1d to 730d or a date, such as 90d or 2026-09-01 — not ${value}`,
    { param: "since_time" },
  )
}

export const projectCutoffTime = (value: string): number => {
  const parsed = v.safeParse(v.pipe(v.string(), v.isoTimestamp()), value)
  const at = parsed.success ? Date.parse(parsed.output) : Number.NaN
  const date = parsed.success ? Date.parse(`${parsed.output.slice(0, 10)}T00:00:00.000Z`) : Number.NaN
  if (
    !parsed.success ||
    !/(Z|[+-]\d{2}:\d{2})$/.test(parsed.output) ||
    !Number.isFinite(at) ||
    at < 1 ||
    !Number.isFinite(date) ||
    new Date(date).toISOString().slice(0, 10) !== parsed.output.slice(0, 10)
  )
    throw new CliError("validation_error", "--before-time needs a real ISO 8601 timestamp with a UTC offset", {
      param: "before_time",
    })
  return at
}

const coverageRows = ({ linkedChats }: StoredProjectGathering): ChatCoverage[] =>
  linkedChats.flatMap((one) =>
    one.completeness === null || one.held === null
      ? []
      : [{ chatId: one.chat, title: one.title, completeness: one.completeness, held: one.held }],
  )

/**
 * The zone a typed start date was read in, and the window the run used, in UTC. `complete` is "the answer is whole":
 * reads finished and every linked chat held in full; the answer's own `complete` stays "reads finished".
 */
export const projectAnswerParts = (sinceTime: string, found: StoredProjectGathering) => {
  const { window } = found
  const { timezone } = dateWindow({ sinceTime }).meta
  const { next, missing } = coverageGaps(coverageRows(found), 0, new Date(window.after).toISOString())
  return {
    ...(next.length ? { next } : {}),
    ...(missing.length ? { missing } : {}),
    meta: {
      ...(timezone === undefined ? {} : { timezone }),
      window: { since: new Date(window.after).toISOString(), until: new Date(window.before).toISOString() },
      complete: found.complete && found.completeness === "complete",
    },
  }
}

export interface ProjectTextHints {
  /** The command that syncs one linked chat back to `since` (`YYYY-MM-DD`), or null when no command here can. */
  sync: (chat: StoredProjectGathering["linkedChats"][number], since: string) => string | null
  /** How to open a document too large to read here. */
  showDocument: string
}

const LABELS: Record<string, string> = {
  "person-only": "  [person only]",
  sender: "  [sent by contact]",
  "linked-chat": "  [linked chat]",
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10)

const FETCH_STATES: Record<string, string> = {
  complete: "synced",
  partial: "synced in part",
  failed: "not synced",
  skipped: "not synced, the fetch time ran out first",
}

export const projectEvidenceText = (found: StoredProjectGathering, hints: ProjectTextHints) => {
  const lanes = new Map(
    found.lanes.map((lane) => [
      lane.id,
      `${lane.query ?? lane.chat ?? `what ${lane.people.join(", ")} wrote`} (${lane.kinds.join(", ")})`,
    ]),
  )
  const linked = found.items.filter((item) => item.context === "linked-chat").length
  const sent = found.items.filter((item) => item.context === "sender").length
  const unreadSenders = found.lanes.filter(
    (lane) => lane.kinds.includes("sender") && !found.units.some((unit) => unit.lane === lane.id),
  )
  const failed = found.units.filter((unit) => unit.state === "failed" || unit.state === "unavailable")
  const lines = [
    `${found.project.name}${found.projectRef ? ` — ${found.projectRef}` : ""}: ${found.items.length} new references, ` +
      `${day(found.window.after)} to ${day(found.window.before)}, ${found.scope.sources.length} sources`,
    `as of: ${new Date(found.window.asOf).toISOString()} (exclusive end; reuse --before-time to repeat this window)`,
    `searched: ${[...lanes.values()].join("; ")}`,
    ...found.items.map(
      (item) =>
        `${day(item.at)}  ${item.ref}${LABELS[item.context] ?? ""}\n    ${item.text}` +
        (item.around ?? [])
          .map((one) => `\n      ${one.found ? "(hit) " : ""}${one.sender ? `${one.sender}: ` : ""}${one.text}`)
          .join(""),
    ),
  ]
  const people = found.people.slice(0, 8)
  const morePeople = found.people.length - people.length + found.peopleOmitted
  if (people.length)
    lines.push(
      `people who wrote these: ${people.map((one) => `${one.name} (${one.items})`).join(", ")}` +
        `${morePeople ? ` and ${morePeople} more` : ""} — by stored contact, not by names in the text; yours left out`,
    )
  if (linked)
    lines.push(`${linked} of these come from the project's linked chats and name nothing: membership, not a word match`)
  if (sent) lines.push(`${sent} of these were written by a contact and may name nothing: matched by sender, not words`)
  for (const lane of unreadSenders)
    lines.push(`${lane.people.join(", ")}: no stored identity in the selected sources, so nothing they wrote was read`)
  if (found.mentions.items.length)
    lines.push(
      `also names: ${found.mentions.items
        .slice(0, 8)
        .map((one) => `${one.target.kind} ${one.target.name} (${one.matches.length})`)
        .join(", ")} — words found, not membership`,
    )
  if (found.matchedAgain.length) lines.push(`${found.matchedAgain.length} earlier references found again`)
  if (found.oversized.length)
    lines.push(
      `too large to read here: ${found.oversized.map((one) => `${one.ref} (${Math.ceil(one.bytes / 1024)} KiB)`).join(", ")}` +
        ` — open each with ${hints.showDocument}`,
    )
  if (failed.length) lines.push(`${failed.length} reads failed or had no source: see --json units`)
  if (found.index.state === "failed" || found.index.state === "unavailable")
    lines.push(`the search index could not be brought up to date first (${found.index.code ?? found.index.state})`)
  const pending = [
    ...new Set(
      found.units.filter((unit) => unit.issue?.startsWith("index-")).map((unit) => found.scope.sources[unit.source]),
    ),
  ]
  if (pending.length)
    lines.push(
      `not yet searchable: new text in ${pending.map((one) => `${one?.provider}:${one?.account}`).join(", ")} ` +
        "is still waiting for the search index, so it was not found",
    )
  if (pending.some((one) => one?.kind === "mail" || one?.kind === "document") && found.index.state === "as-is")
    lines.push("leave out --no-catch-up to index new mail and documents first")
  if (pending.some((one) => one?.kind === "meeting"))
    lines.push(
      "index stored transcript cues through the meeting provider's indexing workflow; mail/document catch-up does not index them",
    )
  if (found.unreadSources.length)
    lines.push(
      `not read: ${found.unreadSources
        .map((one) => `${one.source} (${one.kind}${one.reason ? `, ${one.reason}` : ""})`)
        .join(", ")}`,
    )
  for (const one of found.fetch)
    lines.push(
      `${one.chat}: ${FETCH_STATES[one.state] ?? one.state} before reading` +
        `${one.reason && one.state !== "skipped" ? ` (${one.reason})` : ""}`,
    )
  const held = (one: StoredProjectGathering["linkedChats"][number]) =>
    one.completeness?.state === "unknown" || !one.held?.oldestAt
      ? "never fetched"
      : `held from ${one.held.oldestAt.slice(0, 10)} only`
  for (const one of found.linkedChats)
    if (one.completeness !== null && one.completeness.state !== "complete") {
      const sync = hints.sync(one, day(found.window.after))
      lines.push(
        `${one.title ?? one.ref}: ${held(one)}${one.state === "pending" ? ", not read this run" : ""}` +
          (sync ? ` — sync it: ${sync}` : ""),
      )
    }
  const capped = found.linkedChats.filter((one) => one.capped)
  if (capped.length)
    lines.push(
      `linked chats with more to read, left for --cursor so one chat does not fill the run: ${capped
        .map((one) => `${one.ref} (${one.items} this run)`)
        .join(", ")}`,
    )
  if (found.checkpoint)
    lines.push(
      `stopped${found.stopped ? ` at the ${found.stopped} budget` : ""}; continue with the same options and`,
      `--cursor ${found.checkpoint}`,
    )
  else lines.push("every read finished; a finished search does not prove there is nothing more")
  return lines.join("\n")
}
