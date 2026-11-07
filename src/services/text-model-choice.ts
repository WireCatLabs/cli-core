import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { isTextModelInstalled, textModelsDirectory } from "../embeddings/embed.js"
import {
  CustomTextModelShape,
  chosenTextModel,
  readTextModelsSection,
  type TextModel,
  textModel,
  textModels,
  vectorModelKey,
  writeTextModelsSection,
} from "../embeddings/models.js"
import type { Fetch } from "../speech/install.js"
import { storePath } from "../store/path.js"
import { openStore } from "../store/store.js"

export interface TextModelSwitch {
  model: TextModel
  previous: string
  /** Chunk texts the previous model has vectors for and this one has not: what the next syncs embed. */
  toEmbed: number | null
  /** Embedding time alone at the model's measured speed, done a part per sync; `null` when the speed or the count is unknown. */
  estimateSeconds: number | null
}

/**
 * Makes `id` the model every embed and every search by meaning uses, in every WireCat CLI. Vectors are kept per
 * model, so nothing is deleted or re-embedded here: the next syncs embed what the new model lacks, and search by
 * meaning reads only the new model's vectors, finding by words what it has not reached yet.
 */
export const useTextModel = async (
  id: string,
  { env, command }: { env: NodeJS.ProcessEnv; command: string },
): Promise<TextModelSwitch> => {
  const model = textModel(id, env)
  if (!isTextModelInstalled(model, textModelsDirectory(env)))
    throw new CliError(
      "not_found",
      `${model.id} is not downloaded — \`${command} models download ${model.id}${model.terms ? " --accept-terms" : ""}\` first`,
      { reason: "model.not-downloaded", model: model.id },
    )
  const previous = chosenTextModel(env).id
  const before = textModels(env).find((one) => one.id === previous)
  const toEmbed = previous === model.id ? 0 : before ? await missingVectors(before, model, env) : null
  writeTextModelsSection({ ...readTextModelsSection(env), use: model.id }, env)
  return {
    model,
    previous,
    toEmbed,
    estimateSeconds:
      toEmbed === null || model.chunksPerSecond === undefined ? null : Math.ceil(toEmbed / model.chunksPerSecond),
  }
}

const missingVectors = async (from: TextModel, to: TextModel, env: NodeJS.ProcessEnv): Promise<number | null> => {
  if (!existsSync(storePath(env))) return null
  // Only an estimate: a store that is busy, damaged or older than this build must not stop the switch.
  try {
    const store = await openStore({ env })
    try {
      const counts = await store.vectors.vectorCounts([vectorModelKey(from), vectorModelKey(to)])
      return Math.max(0, (counts.get(vectorModelKey(from)) ?? 0) - (counts.get(vectorModelKey(to)) ?? 0))
    } finally {
      await store.close()
    }
  } catch {
    return null
  }
}

/** What `models add --payload` takes: where the model is and how to run it; the files' sizes and hashes are looked up. */
export const CustomModelRequest = v.strictObject({
  /** A Hugging Face repository, `owner/name`. */
  repository: v.pipe(v.string(), v.regex(/^[\w.-]+\/[\w.-]+$/, "is not a Hugging Face repository, owner/name")),
  /** A branch, tag or commit; pinned to the commit it names now. */
  revision: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  onnx: v.string(),
  externalData: v.optional(v.string()),
  dims: v.number(),
  pooling: v.picklist(["mean", "sentence_embedding"]),
  prefix: v.strictObject({ query: v.string(), passage: v.string() }),
  maxTokens: v.optional(v.number()),
  title: v.optional(v.string()),
  languages: v.optional(v.string()),
  licence: v.optional(v.string()),
  chunksPerSecond: v.optional(v.number()),
})
export type CustomModelRequest = v.InferOutput<typeof CustomModelRequest>

const invalid = (what: string, issues: [v.BaseIssue<unknown>, ...v.BaseIssue<unknown>[]]) => {
  const at = v.getDotPath(issues[0])
  return new CliError("validation_error", `${what}${at ? ` ${at}` : ""} ${issues[0].message}`)
}

const HUB = "https://huggingface.co"
/** Larger files are stored through LFS, whose listing gives their sha256; a small one is fetched and hashed here. */
const SMALL_FILE_MOST = 20_000_000

const hubJson = async (get: Fetch, url: string): Promise<unknown> => {
  const response = await get(url)
  if (!response.ok) {
    await response.body?.cancel()
    throw new CliError(
      response.status === 404 || response.status === 401 ? "not_found" : "network_error",
      `Hugging Face answered HTTP ${response.status} for ${url}`,
    )
  }
  return response.json()
}

const Revision = v.object({ sha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/)), cardData: v.optional(v.unknown()) })
const Tree = v.array(
  v.object({
    path: v.string(),
    type: v.optional(v.string()),
    size: v.optional(v.number()),
    lfs: v.optional(v.object({ oid: v.string(), size: v.optional(v.number()) })),
  }),
)

/**
 * A model from a Hugging Face repository, pinned to one commit with each file's size and sha256, as the built-in
 * ones are, and kept in the shared settings file beside the choice. It is checked again on `models download`,
 * which also embeds a word to see the vector has `dims` numbers. Adding an id again replaces its definition.
 */
export const addCustomTextModel = async (
  id: string,
  payload: unknown,
  { env, fetch: get = fetch }: { env: NodeJS.ProcessEnv; fetch?: Fetch },
): Promise<TextModel> => {
  const given = v.safeParse(CustomModelRequest, payload)
  if (!given.success) throw invalid("--payload", given.issues)
  const request = given.output
  const revision = v.safeParse(
    Revision,
    await hubJson(
      get,
      `${HUB}/api/models/${request.repository}/revision/${encodeURIComponent(request.revision ?? "main")}`,
    ),
  )
  if (!revision.success) throw new CliError("invalid_response", "Hugging Face gave no commit for that revision")
  const commit = revision.output.sha
  const names = [
    ...new Set([request.onnx, request.externalData, "tokenizer.json", "tokenizer_config.json"].filter(Boolean)),
  ] as string[]
  const folders = [...new Set(names.map((name) => name.split("/").slice(0, -1).join("/")))]
  const listed = new Map<string, v.InferOutput<typeof Tree>[number]>()
  for (const folder of folders) {
    const tree = v.safeParse(
      Tree,
      await hubJson(get, `${HUB}/api/models/${request.repository}/tree/${commit}${folder ? `/${folder}` : ""}`),
    )
    if (!tree.success) throw new CliError("invalid_response", "Hugging Face gave an unreadable file list")
    for (const entry of tree.output) listed.set(entry.path, entry)
  }
  const url = (name: string) => `${HUB}/${request.repository}/resolve/${commit}/${name}`
  const files = []
  for (const name of names) {
    const entry = listed.get(name)
    if (!entry) throw new CliError("not_found", `${request.repository} has no ${name} at ${commit.slice(0, 12)}`)
    if (entry.lfs) {
      files.push({ name, url: url(name), sha256: entry.lfs.oid, bytes: entry.lfs.size ?? entry.size ?? 0 })
      continue
    }
    if ((entry.size ?? 0) > SMALL_FILE_MOST)
      throw new CliError("invalid_response", `${name} is large and not in LFS, so it has no sha256 to pin`)
    const response = await get(url(name))
    if (!response.ok) throw new CliError("network_error", `${name} could not be downloaded: HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    files.push({ name, url: url(name), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length })
  }
  const card = revision.output.cardData as { license?: unknown } | undefined
  const checked = v.safeParse(CustomTextModelShape, {
    id,
    title: request.title ?? `${request.repository} (${request.onnx})`,
    languages: request.languages ?? "as the model card says",
    licence:
      request.licence ??
      (typeof card?.license === "string" ? card.license : `unknown — read ${HUB}/${request.repository}`),
    dims: request.dims,
    maxTokens: request.maxTokens ?? 512,
    ...(request.chunksPerSecond === undefined ? {} : { chunksPerSecond: request.chunksPerSecond }),
    pooling: request.pooling,
    prefix: request.prefix,
    onnx: request.onnx,
    ...(request.externalData ? { externalData: request.externalData } : {}),
    files,
  })
  if (!checked.success) throw invalid("the model", checked.issues)
  const section = readTextModelsSection(env)
  writeTextModelsSection(
    { ...section, custom: [...(section.custom ?? []).filter((one) => one.id !== id), checked.output] },
    env,
  )
  return { ...checked.output, custom: true }
}
