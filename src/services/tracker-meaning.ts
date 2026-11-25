import { CliError } from "@wirecat/cli-base"
import { meaningFloor } from "../embeddings/models.js"
import type { AccountKey, MessageStore, TrackerNearest } from "../store/store.js"
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
 * Embeds issues', projects' and comments' chunks as notes' are embedded. Items gone since lose theirs first, and items
 * saved before tracker items were searched by meaning get theirs.
 */
export const embedTracker = async (store: MessageStore, options: NotesEmbedOptions & { command?: string } = {}) => {
  // A missing model fails before anything is written; the refresh stops where the embedding would.
  localModel(options.model, options.env, options.command)
  const until = stopsAt(options.deadline)
  await store.tracker.refreshChunks({ until: () => options.signal?.aborted === true || Date.now() >= until })
  return embedChunks(store, store.tracker, options)
}

/**
 * Issues, projects and comments of these accounts nearest in meaning to plain words, nearer than the model's floor,
 * best first; only items already embedded are found.
 */
export const nearestTracker = async (
  store: MessageStore,
  words: string,
  {
    limit,
    accounts,
    env,
    command,
    embedders,
  }: Pick<NearestOptions, "env" | "command" | "embedders"> & { limit: number; accounts: readonly AccountKey[] },
): Promise<TrackerNearest[]> => {
  const { model, directory, key } = localModel(await meaningModel(store, env), env, command)
  if (!(await store.tracker.embedded(key, accounts)))
    throw new CliError(
      "not_found",
      `no issue, project or comment has vectors of ${model.id} yet, so only words were matched`,
      { reason: "tracker.no-vectors", model: model.id },
    )
  const [vector] = await withLocal(
    model,
    directory,
    undefined,
    (embedder) => embedder.embed([words], "query"),
    embedders,
  )
  const floor = meaningFloor(key)
  return (await store.tracker.nearest(key, vector as Float32Array, { limit, accounts })).filter(
    ({ score }) => score > floor,
  )
}
