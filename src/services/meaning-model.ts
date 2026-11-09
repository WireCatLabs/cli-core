import { isTextModelInstalled, textModelsDirectory } from "../embeddings/embed.js"
import {
  chosenTextModel,
  DEFAULT_TEXT_MODEL,
  PREVIOUS_DEFAULT_TEXT_MODEL,
  textModels,
  vectorModelKey,
} from "../embeddings/models.js"
import type { MessageStore } from "../store/store.js"

/**
 * The model a search by meaning reads. A model the owner chose, always. With none chosen, the default, unless this
 * store still holds more vectors of the previous default: so after EmbeddingGemma became the default, search keeps
 * reading e5-small's vectors while the syncs embed the store again, and moves to Gemma once it has caught up.
 */
export const meaningModel = async (store: MessageStore, env: NodeJS.ProcessEnv = process.env): Promise<string> => {
  const chosen = chosenTextModel(env)
  if (chosen.from === "chosen" || chosen.id !== DEFAULT_TEXT_MODEL) return chosen.id
  const models = textModels(env)
  const current = models.find(({ id }) => id === DEFAULT_TEXT_MODEL)
  const previous = models.find(({ id }) => id === PREVIOUS_DEFAULT_TEXT_MODEL)
  if (!current || !previous || !isTextModelInstalled(previous, textModelsDirectory(env))) return chosen.id
  const [now, before] = [vectorModelKey(current), vectorModelKey(previous)]
  const counts = await store.vectors.vectorCounts([now, before])
  return (counts.get(before) ?? 0) > (counts.get(now) ?? 0) ? previous.id : current.id
}
