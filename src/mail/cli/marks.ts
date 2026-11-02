import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import * as v from "valibot"
import { answerEntity } from "../../cli/answer-entity.js"
import { outputFor } from "../../cli/context.js"
import { LOCAL_WRITE, proposesOnly } from "../../cli/effects.js"
import { itemOf, renderAnswer } from "../../cli/envelope.js"
import { acknowledgeMark, type MailMark } from "../marks.js"
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
 * only moves the holder's own bookkeeping forward, so a read-only scheduled run may do it.
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
      const mark = await mail.read(this, (store, mailbox) => acknowledgeMark(store, mailbox, holder, cursor))
      renderAnswer(this, outputFor(this), itemOf(markItem(mark)), () => markText(mark))
    })
