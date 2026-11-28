import { CliError } from "@wirecat/cli-base"
import type { DealKind } from "../domain/deals.js"
import { meaningFloor } from "../embeddings/models.js"
import type { AccountKey, CopyViewer, CrmActivityNearest, MessageStore } from "../store/store.js"
import { meaningModel } from "./meaning-model.js"
import {
  embedChunks,
  localModel,
  type NearestOptions,
  type NotesEmbedOptions,
  stopsAt,
  withLocal,
} from "./notes-search.js"

/**
 * Embeds CRM activities' and tasks' chunks as notes' are embedded. Activities gone since lose theirs first, and those
 * saved before activities were searched by meaning get theirs.
 */
export const embedCrmActivities = async (
  store: MessageStore,
  options: NotesEmbedOptions & { command?: string } = {},
) => {
  // A missing model fails before anything is written; the refresh stops where the embedding would.
  localModel(options.model, options.env, options.command)
  const until = stopsAt(options.deadline)
  const refreshed = await store.crm.activityChunks.refresh({
    until: () => options.signal?.aborted === true || Date.now() >= until,
  })
  const embedded = await embedChunks(store, store.crm.activityChunks, options)
  // Activities the refresh had no time to cut are left too, though no chunk of theirs waits yet.
  return refreshed.left ? { ...embedded, left: true } : embedded
}

/**
 * The deals and leads of these accounts whose activities are nearest in meaning to plain words, nearer than the
 * model's floor, best first; only activities already embedded are found.
 */
export const nearestCrmActivities = async (
  store: MessageStore,
  words: string,
  {
    limit,
    accounts,
    kinds,
    viewers,
    env,
    command,
    embedders,
  }: Pick<NearestOptions, "env" | "command" | "embedders"> & {
    limit: number
    /** Every account holding activities when left out. */
    accounts?: readonly AccountKey[] | undefined
    kinds?: readonly DealKind[]
    viewers?: readonly CopyViewer[]
  },
): Promise<CrmActivityNearest[]> => {
  const { model, directory, key, engine } = localModel(await meaningModel(store, env), env, command)
  if (!(await store.crm.activityChunks.embedded(key, accounts)))
    throw new CliError("not_found", `no CRM activity has vectors of ${model.id} yet, so only words were matched`)
  const [vector] = await withLocal(
    model,
    directory,
    undefined,
    (embedder) => embedder.embed([words], "query"),
    embedders,
    engine,
  )
  const floor = meaningFloor(key)
  return (
    await store.crm.activityChunks.nearest(key, vector as Float32Array, {
      limit,
      ...(accounts === undefined ? {} : { accounts }),
      ...(kinds === undefined ? {} : { kinds }),
      ...(viewers === undefined ? {} : { viewers }),
    })
  ).filter(({ score }) => score > floor)
}
