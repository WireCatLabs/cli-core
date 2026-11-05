import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import * as v from "valibot"
import { answerEntity } from "../../cli/answer-entity.js"
import { actorOf } from "../../cli/author.js"
import { environmentOf, outputFor } from "../../cli/context.js"
import { LOCAL_WRITE, proposesOnly } from "../../cli/effects.js"
import { itemOf, renderAnswer } from "../../cli/envelope.js"
import { mailHolderVariable, readOnlyLockOf } from "../../ports/app.js"
import { momentOf } from "../../services/moment.js"
import { acknowledgeMark, type MailMark, rewindMark } from "../marks.js"
import type { MailReads } from "./index.js"

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

/** A holder's mark as `--json`, `mail status` and MCP show it. */
export const mailMark = v.strictObject({
  holder: v.string(),
  through_id: v.number(),
  through_received_at: v.nullable(v.string()),
  held: v.number(),
  read: v.number(),
  skipped: v.strictObject({
    bulk: v.number(),
    envelope: v.number(),
    partial: v.number(),
    draft: v.number(),
    suspicious: v.number(),
  }),
  updated_at: v.string(),
})

export const markItem = (mark: MailMark): v.InferOutput<typeof mailMark> => ({
  holder: mark.holder,
  through_id: mark.throughId,
  through_received_at: iso(mark.throughAt),
  held: mark.held.length,
  read: mark.read,
  skipped: mark.skipped,
  updated_at: iso(mark.updatedAt) as string,
})

export const markText = (mark: MailMark) =>
  `${mark.holder}  through ${mark.throughId}${mark.throughAt === null ? "" : ` (${iso(mark.throughAt)})`}  ` +
  `read ${mark.read}  held ${mark.held.length}  skipped bulk ${mark.skipped.bulk}, envelope ${mark.skipped.envelope}, ` +
  `partial ${mark.skipped.partial}, draft ${mark.skipped.draft}, suspicious ${mark.skipped.suspicious}  ` +
  `updated ${iso(mark.updatedAt)}\n`

/**
 * `messages acknowledge`: a holder says it is done with what `review --holder` gave it, and its mark moves there. It
 * only moves the holder's own bookkeeping forward, so a read-only scheduled run may do it — for the holder its
 * schedule names only: an email that talks its reader into acknowledging would otherwise silence another pipeline.
 */
export const acknowledgeCommand = (mail: MailReads): Command =>
  answerEntity(
    proposesOnly(
      annotate(new Command("acknowledge"), {
        effects: LOCAL_WRITE,
        examples: [
          `${mail.app.command} personal messages acknowledge --holder mail-triage --cursor 9123.1762090000000`,
        ],
      }),
    ),
    "mail_mark",
    mailMark,
  )
    .summary("move a holder's processing mark to what it has read")
    .description(
      "record that a holder — an agent or a pipeline — processed the mail `review --holder` gave it, with the cursor " +
        "that review gave; the mark only moves forward, and mail still partial waits for the next review",
    )
    .requiredOption("--holder <name>", "whose mark: lower-case letters, digits and dashes, such as mail-triage")
    .requiredOption("--cursor <cursor>", "the cursor `review --holder` gave")
    .action(async function (this: Command) {
      const { holder, cursor } = this.opts<{ holder: string; cursor: string }>()
      const env = environmentOf(this).env ?? process.env
      const named = env[mailHolderVariable(mail.app)]?.trim()
      const owner = actorOf(this) === "owner" && !readOnlyLockOf(mail.app, env)
      if (named ? named !== holder : !owner)
        throw new CliError(
          "permission_error",
          named
            ? `this run moves only ${named}'s mark, not ${holder}'s`
            : `an agent moves only the mark of the holder its schedule names (schedule agent --on-new-mail ${holder}); the owner moves any`,
          { reason: "mail.holder-not-yours" },
        )
      const mark = await mail.read(this, (store, mailbox) => acknowledgeMark(store, mailbox, holder, cursor))
      renderAnswer(this, outputFor(this), itemOf(markItem(mark)), () => markText(mark))
    })

const mailMarkReset = v.strictObject({
  mark: mailMark,
  /** Where the mark was before. */
  from_id: v.number(),
  /** Emails the holder reads whole again. */
  again: v.number(),
  /** Bulk emails it gets again as excerpts, unless they are surely newsletters. */
  bulk: v.number(),
  /** Emails between the two marks it skips again: drafts, envelopes, suspicious senders, partial mail. */
  skipped: v.number(),
  /** Nothing moved: `--dry-run` only counts. */
  dry_run: v.boolean(),
})

const wholeNumber = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new CliError("validation_error", `--last takes a whole number of emails, 1 or more — got ${value}`)
  return parsed
}

/**
 * `messages reset`: the owner moves a holder's mark back, so its next reviews give it that mail again — after its
 * rules changed, say. An agent never does: a holder that could move its own mark back could be talked by an email
 * into reading the whole mailbox again, so this is no proposal and the read-only lock refuses it.
 */
export const resetMarkCommand = (mail: MailReads): Command =>
  answerEntity(
    annotate(new Command("reset"), {
      effects: LOCAL_WRITE,
      examples: [
        `${mail.app.command} personal messages reset --holder mail-triage --last 8 --dry-run`,
        `${mail.app.command} personal messages reset --holder mail-triage --since-time 2026-11-04T00:00:00Z`,
      ],
    }),
    "mail_mark_reset",
    mailMarkReset,
  )
    .summary("move a holder's processing mark back, so it reads that mail again (owner only)")
    .description(
      "the owner moves a holder's mark back past the mail received since --since-time, or past the last --last " +
        "emails it was given; its next reviews give that mail again. The answer says how many emails it reads " +
        "again. An agent cannot: a holder only moves its own mark forward, with `messages acknowledge`",
    )
    .requiredOption("--holder <name>", "whose mark: lower-case letters, digits and dashes, such as mail-triage")
    .option("--since-time <time>", "read again what was received since this ISO 8601 time, or 2d ago")
    .option("--last <n>", "read again the last n emails the holder was given", wholeNumber)
    .option("--dry-run", "count what would be read again, and move nothing")
    .action(async function (this: Command) {
      const { holder, sinceTime, last, dryRun } = this.opts<{
        holder: string
        sinceTime?: string
        last?: number
        dryRun?: boolean
      }>()
      if ((sinceTime === undefined) === (last === undefined))
        throw new CliError("validation_error", "give --since-time or --last, one of them")
      const env = environmentOf(this).env ?? process.env
      if (env[mailHolderVariable(mail.app)]?.trim() || actorOf(this) !== "owner" || readOnlyLockOf(mail.app, env))
        throw new CliError(
          "permission_error",
          "only the owner moves a holder's mark back; an agent only acknowledges",
          {
            reason: "mail.reset-owner-only",
          },
        )
      const now = Date.now()
      const to = last === undefined ? { since: momentOf(sinceTime as string, "--since-time", now) } : { last }
      const reset = await mail.read(this, (store, mailbox) =>
        rewindMark(store, mailbox, holder, to, { now, dry: dryRun === true }),
      )
      const item = {
        mark: markItem(reset.mark),
        from_id: reset.fromId,
        again: reset.again,
        bulk: reset.bulk,
        skipped: reset.skipped,
        dry_run: reset.dry,
      }
      renderAnswer(this, outputFor(this), itemOf(item), () => {
        const mark =
          reset.mark.throughId === reset.fromId
            ? `the mark stays at ${reset.fromId}`
            : `the mark ${reset.dry ? "would move" : "moved"} from ${reset.fromId} to ${reset.mark.throughId}`
        return (
          `${holder} ${reset.dry ? "would read" : "reads"} ${reset.again} emails again, and ${reset.bulk} bulk ` +
          `ones as excerpts unless they are newsletters; ${reset.skipped} are skipped again; ${mark}\n`
        )
      })
    })
