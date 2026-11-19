import { CliError, type KeyringStore } from "@wirecat/cli-base"
import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import type { Missing } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import * as v from "valibot"
import { answerEntity } from "../../cli/answer-entity.js"
import { environmentOf, outputFor } from "../../cli/context.js"
import { FETCH, reachesOtherService, refuseUnderReadOnly } from "../../cli/effects.js"
import { listOf } from "../../cli/envelope.js"
import { answerLocally } from "../../cli/local-times.js"
import { answerOf as askOwner } from "../../cli/messenger/ask.js"
import { positiveCount } from "../../cli/paging.js"
import { formatReference } from "../../domain/references.js"
import { reference, text, time, untrusted } from "../../entities/fields.js"
import { aiBaseUrl, aiSettingPath, aiTextReader, readAiSetting } from "../../models/ai.js"
import { chatSendingAllowed, chatSendingAskRefusal } from "../../models/chat-sending.js"
import { localOnly, localOnlyRefusal } from "../../models/local-only.js"
import { agentOf } from "../../runs/run-context.js"
import type { AccountKey } from "../../store/store.js"
import {
  INBOX_BUCKETS,
  INBOX_LIMITS,
  INBOX_SYSTEM,
  type InboxBucket,
  type InboxSkip,
  type InboxThread,
  type InboxVerdict,
  inboxDue,
  inboxPrompt,
  inboxVerdicts,
  parseInboxAnswer,
  planInbox,
  saveInbox,
} from "../inbox.js"
import type { MailReads } from "./index.js"

export interface MailInboxOptions {
  /** Where the owner chooses the shared AI model and the `models chats` setting; mail has no `models` of its own. */
  modelsCommand?: string
  keyring?: KeyringStore
  fetch?: typeof globalThis.fetch
}

const BUCKET_WORDS: Record<InboxBucket, string> = { answer: "needs an answer", read: "to read", later: "can wait" }

const inboxThread = v.strictObject({
  ref: reference,
  title: v.nullable(text),
  bucket: v.picklist(INBOX_BUCKETS),
  reason: text,
  last_email_at: time,
  sorted_at: time,
  by: text,
  untrusted,
})

const itemOf = (mailbox: AccountKey) => (one: InboxVerdict) => ({
  ref: formatReference({ type: "chat", ...mailbox, chat: one.thread }),
  title: one.title,
  bucket: one.bucket,
  reason: one.reason,
  last_email_at: one.lastEmailAt,
  sorted_at: one.sortedAt,
  by: one.by,
  // The reason is the model's reading of mail other people wrote.
  untrusted: ["title", "reason"],
})

interface Run {
  sorted: number
  answered: number
  left: number
  skipped: { ref: string; why: InboxSkip }[]
  quiet: number
  overflow: number
  stopped?: "messages" | "tokens"
  failed?: string
}

const missingOf = (run: Run | undefined, command: string): Missing[] => {
  if (!run) return []
  return [
    ...(run.left > 0
      ? [
          {
            field: "items",
            why:
              `${run.left} threads wait for the next run: --max-${run.stopped === "tokens" ? "tokens" : "messages"} ` +
              `was reached; \`${command} inbox\` again sorts them`,
          },
        ]
      : []),
    ...(run.overflow > 0
      ? [{ field: "items", why: `${run.overflow} more threads changed; the next run reads them` }]
      : []),
    ...(run.skipped.length > 0
      ? [
          {
            field: "items",
            why:
              `the model gave no usable answer for ${run.skipped.filter(({ why }) => why === "not-answered").length} ` +
              `threads (${[...new Set(run.skipped.map(({ why }) => why))].join(", ")}); the next run asks again`,
          },
        ]
      : []),
    ...(run.failed ? [{ field: "items", why: `the AI model failed after ${run.sorted} threads: ${run.failed}` }] : []),
    ...(run.quiet > 0 ? [{ field: "items", why: `${run.quiet} threads of mail sent to many were not sorted` }] : []),
  ]
}

/**
 * `inbox`: the threads that changed since its last run, sorted by the shared AI model into those that need an answer,
 * those to read and those that can wait, each with a one-line reason; then every sorted thread still open. It runs
 * the model through its API, with no agent: an agent reads `review` and sorts the mail itself.
 */
export const mailInboxCommand = sharedCommand(
  (mail: MailReads, options: MailInboxOptions = {}): Command =>
    answerEntity(
      reachesOtherService(
        annotate(new Command("inbox"), {
          effects: FETCH,
          partial: true,
          examples: [
            `${mail.app.command} personal inbox`,
            `${mail.app.command} personal inbox --max-messages 20`,
            `${mail.app.command} personal inbox --offline --json`,
          ],
        }),
      ),
      "mail_inbox_thread",
      inboxThread,
    )
      .summary("new mail sorted by the AI model: needs an answer, to read, can wait")
      .description(
        "send the threads that changed since the last run to the AI model the owner chose (`models ai`), which sorts " +
          "each into needs an answer, to read or can wait with a one-line reason; then list every sorted thread, " +
          "those that need an answer first. Mail sent to many is not sent. A model outside this computer follows " +
          "`models chats` and local only. --offline lists what is sorted and sends nothing",
      )
      .option(
        "--max-messages <n>",
        `send at most this many emails in this run; the rest wait for the next (default: ${INBOX_LIMITS.emails})`,
        positiveCount("--max-messages"),
      )
      .option(
        "--max-tokens <n>",
        `stop before a request that would make the run send more tokens than this (default: ${INBOX_LIMITS.tokens})`,
        positiveCount("--max-tokens"),
      )
      .action(async function (this: Command) {
        const flags = this.optsWithGlobals<{
          maxMessages?: number
          maxTokens?: number
          offline?: boolean
          yes?: boolean
        }>()
        const environment = environmentOf(this)
        const env = environment.env ?? process.env
        const models = options.modelsCommand ?? mail.app.command
        const offline = flags.offline === true
        if (!offline && (environment.agent || agentOf(env)))
          throw new CliError(
            "permission_error",
            `an agent sorts mail itself: read \`${mail.app.command} review --new\`; ` +
              `\`${mail.app.command} inbox --offline\` lists what the AI model sorted`,
            { reason: "mail.inbox-agent" },
          )
        const now = Date.now()
        const { verdicts, mailbox, run } = await mail.read(this, async (store, mailbox) => {
          if (offline) return { verdicts: await inboxVerdicts(store, mailbox), mailbox, run: undefined }
          const run = await sortNew(this, store, mailbox, { ...options, app: mail.app, models, env, now, flags })
          return { verdicts: await inboxVerdicts(store, mailbox), mailbox, run }
        })
        const output = outputFor(this)
        const body = listOf("inbox", {
          items: verdicts.map(itemOf(mailbox)),
          limit: Math.max(1, verdicts.length),
          has_more: false,
          missing: missingOf(run, `${mail.app.command}`),
          ...(run && (run.left > 0 || run.overflow > 0 || run.skipped.length > 0 || run.failed)
            ? { meta: { complete: false } }
            : {}),
        })
        answerLocally(this, output, body, (local) => {
          if (run)
            output.renderer.note(
              `sorted ${run.sorted} threads${run.answered ? `, ${run.answered} answered by you` : ""}` +
                (run.left ? `, ${run.left} wait for the next run` : ""),
            )
          if (verdicts.length === 0) {
            output.renderer.note("nothing sorted yet")
            return ""
          }
          return verdicts
            .map(
              (one) =>
                `[${BUCKET_WORDS[one.bucket]}] ${one.title ?? "(no subject)"} · ${local(one.lastEmailAt)}\n  ${one.reason}\n`,
            )
            .join("")
        })
      }),
)

const sortNew = async (
  command: Command,
  store: Parameters<Parameters<MailReads["read"]>[1]>[0],
  mailbox: AccountKey,
  given: MailInboxOptions & {
    app: MailReads["app"]
    models: string
    env: NodeJS.ProcessEnv
    now: number
    flags: { maxMessages?: number; maxTokens?: number; yes?: boolean }
  },
): Promise<Run> => {
  const { models, env, now, flags } = given
  const due = await inboxDue(store, mailbox, now)
  const plan = planInbox(due, {
    emails: flags.maxMessages ?? INBOX_LIMITS.emails,
    tokens: flags.maxTokens ?? INBOX_LIMITS.tokens,
  })
  const run: Run = {
    sorted: 0,
    answered: due.answered.length,
    left: plan.left,
    skipped: [],
    quiet: due.quiet,
    overflow: due.skipped,
    ...(plan.stopped ? { stopped: plan.stopped } : {}),
  }
  if (plan.batches.length === 0) {
    await saveInbox(store, mailbox, due, [], { by: "none", now, complete: due.complete && plan.left === 0 })
    return run
  }
  const reader = aiTextReader({ app: given.app, env, keyring: given.keyring, fetch: given.fetch })
  if ("refused" in reader)
    throw new CliError(
      "configuration_error",
      reader.refused === "ai.not-set"
        ? `no AI model is chosen: choose one with \`${models} models ai set <provider> --model <model>\` or in ` +
            "WireCat Desktop; nothing was sent"
        : `no API key is stored for the AI model: store it with \`${models} models ai set … --secret-stdin\`; ` +
            "nothing was sent",
      { reason: reader.refused },
    )
  if (reader.leavesComputer) {
    const setting = readAiSetting(aiSettingPath(env))
    const host = setting ? new URL(aiBaseUrl(setting)).host : reader.by
    if (localOnly(env)) throw localOnlyRefusal("the text of your new mail", host)
    refuseUnderReadOnly(command, `send mail to ${host}`)
    if (!chatSendingAllowed(env, host, models) && flags.yes !== true) {
      const what =
        `${plan.emails} emails of ${plan.batches.flat().length} threads (about ${plan.tokens} tokens) go to ` +
        `${reader.by} at ${host}`
      const answer = await askOwner(command, `${what}. Send them? [y/N] `)
      if (answer === null) throw chatSendingAskRefusal(what, models)
      if (!/^y(es)?$/i.test(answer.trim())) throw new CliError("cancelled", "cancelled — nothing was sent")
    }
  }
  const sorted: (InboxThread & { bucket: InboxBucket; reason: string })[] = []
  for (const batch of plan.batches) {
    let answer: ReturnType<typeof parseInboxAnswer>
    try {
      const text = await reader.complete({
        purpose: "mail-inbox",
        system: INBOX_SYSTEM,
        prompt: inboxPrompt(batch),
        maxTokens: 4096,
      })
      answer = parseInboxAnswer(text, batch)
    } catch (error) {
      // What is sorted so far is kept; the rest comes with the next run.
      if (sorted.length === 0) throw error
      run.failed = error instanceof CliError ? ((error.details as { reason?: string }).reason ?? error.code) : "failed"
      run.left += plan.batches.slice(plan.batches.indexOf(batch)).flat().length
      break
    }
    run.skipped = run.skipped.concat(answer.skipped)
    for (const thread of batch) {
      const verdict = answer.verdicts.get(thread.thread)
      if (verdict) sorted.push({ ...thread, ...verdict })
    }
  }
  run.sorted = sorted.length
  const complete = due.complete && run.left === 0 && run.skipped.length === 0 && run.failed === undefined
  await saveInbox(store, mailbox, due, sorted, { by: reader.by, now, complete })
  return run
}
