import { type ErrorCode, isCliError } from "@wirecat/cli-base"
import type { NextStep } from "@wirecat/cli-base/standards"
import type { Command } from "commander"
import * as v from "valibot"
import { environmentOf } from "../../cli/context.js"
import { commandAt, rootOf } from "../../cli/steps.js"
import { count, text } from "../../entities/fields.js"
import type { AppIdentity } from "../../ports/app.js"
import { embedCrmActivities } from "../../services/crm-meaning.js"
import type { MessageStore } from "../../store/store.js"
import type { CrmSyncReport } from "../sync.js"

/** At most this many activity chunks per `sync --embed`, as the tracker's sync embeds. */
const EMBED_MAX = 600

/** What `sync --embed` embedded of the activities and tasks: `embedCrmActivities`'s answer. */
export const crmSyncEmbeddings = v.strictObject({
  model: text,
  embedded: count,
  left: v.boolean(),
  stopped: v.optional(v.picklist(["deadline", "cancelled"])),
  remaining: v.optional(count),
})

/**
 * `sync --embed` after the sync saved its report: the activities' vectors, or the issue a missing model makes. A run
 * its budget stopped has no time left for the model; the run that finishes the round embeds.
 */
export const syncEmbeddings = async (
  command: Command,
  store: MessageStore,
  report: Pick<CrmSyncReport, "stopped">,
  app: AppIdentity,
  /** The sync's own arguments, so the step that embeds the rest runs the same sync. */
  again: Record<string, unknown>,
): Promise<{
  item: { embeddings?: Awaited<ReturnType<typeof embedCrmActivities>> }
  issues: { code: ErrorCode; reason: string; source: string }[]
  next?: NextStep[]
}> => {
  if (report.stopped) return { item: {}, issues: [] }
  const { env, deadline, signal } = environmentOf(command)
  const ends = deadline?.()
  try {
    const embeddings = await embedCrmActivities(store, {
      maxChunks: EMBED_MAX,
      ...(ends ? { deadline: ends } : {}),
      ...(signal ? { signal } : {}),
      ...(env ? { env } : {}),
      ...(commandAt(rootOf(command), "models download") ? { command: app.command } : {}),
    })
    // One run embeds at most EMBED_MAX: until the rest are in, a note's deal may still be missing from search all.
    if (!embeddings.left) return { item: { embeddings }, issues: [] }
    return {
      item: { embeddings },
      issues: [],
      next: [
        {
          kind: "command",
          step: "crm.sync",
          command: "sync",
          args: Object.fromEntries(
            Object.entries({ ...again, embed: true }).filter(([, value]) => value !== undefined),
          ),
          why:
            `${embeddings.remaining === undefined ? "some" : embeddings.remaining} activity chunks have no vectors ` +
            "yet, so search all may miss their deals by meaning; running sync --embed again embeds the next ones",
          safe_to_auto_execute: true,
        },
      ],
    }
  } catch (error) {
    // What the sync saved is answered; a cancel still ends the command.
    if (signal?.aborted || !isCliError(error)) throw error
    const reason = error.details.reason
    return {
      item: {},
      issues: [
        { code: error.code, reason: typeof reason === "string" ? reason : "sync.failed", source: "crm:embeddings" },
      ],
    }
  }
}
