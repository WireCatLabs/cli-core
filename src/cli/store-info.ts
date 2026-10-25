import { existsSync, statSync } from "node:fs"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import type * as v from "valibot"
import type { storeInfo as storeInfoEntity } from "../entities/store-maintenance.js"
import { compatibilityOf, fileSchemaOf } from "../store/compatibility.js"
import type { CacheDatabase } from "../store/driver.js"
import { storePath } from "../store/path.js"
import {
  openSqlite,
  pendingNormalization,
  rowCounts,
  searchIndexState,
  stemsState,
  storeClients,
  storeContents,
} from "../store/store.js"
import { environmentOf, outputFor } from "./context.js"
import { LOCAL_READ } from "./effects.js"
import { itemOf, renderAnswer, snakeKeys } from "./envelope.js"

export type StoreInfo = v.InferOutput<typeof storeInfoEntity>

/** Before version 6 the column does not exist, and a file behind this build is not migrated here. */
const pendingIfKnown = (database: CacheDatabase): number | null =>
  database.prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name = 'normalized_text'").get()
    ? pendingNormalization(database)
    : null

const bytesOf = (path: string) => (existsSync(path) ? statSync(path).size : 0)

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A file this build may not open may have renamed what the counts read, so only its schema is reported. */
const contentsOf = (database: CacheDatabase, version: number, writable: boolean) =>
  version > 0 && writable
    ? {
        rows: rowCounts(database),
        pendingNormalization: pendingIfKnown(database),
        wordIndex: searchIndexState(database) ?? null,
        stemIndex: stemsState(database) ?? null,
        ...storeContents(database),
      }
    : { rows: {}, pendingNormalization: null, wordIndex: null, stemIndex: null }

/**
 * The shared store as this build sees it, for any WireCat tool. Opened read-only: it never migrates, never sets a
 * journal mode, and answers for a file newer than this build instead of refusing it.
 */
export const storeInfo = async (env: NodeJS.ProcessEnv): Promise<StoreInfo> => {
  const path = storePath(env)
  if (!existsSync(path)) return snakeKeys({ path, exists: false, schema: compatibilityOf(undefined) }) as StoreInfo
  let schema = compatibilityOf(undefined)
  try {
    const { database } = await openSqlite(path, { readOnly: true })
    try {
      schema = compatibilityOf(fileSchemaOf(database))
      const answer = {
        path,
        exists: true,
        bytes: { file: bytesOf(path), wal: bytesOf(`${path}-wal`) },
        schema,
        clients: storeClients(database).map(({ seenAt, ...client }) => ({
          ...client,
          seenAt: new Date(seenAt).toISOString(),
        })),
        ...contentsOf(database, schema.version, schema.writable),
      }
      return snakeKeys(answer) as StoreInfo
    } finally {
      database.close()
    }
  } catch (error) {
    const { speaks } = schema
    return snakeKeys({ path, exists: true, opens: false, error: messageOf(error), schema: { speaks } }) as StoreInfo
  }
}

export const storeInfoCommand = (): Command =>
  annotate(new Command("info"), { output: { entity: "store_info" }, effects: LOCAL_READ })
    .summary("the shared store's format, size and contents, and whether this tool can read it")
    .description(
      "the store file: where it is, its size, its schema against the one this tool speaks, which tools used it and how many rows it holds, by provider, chat kind, account, year (UTC) and attachment kind, over every account; changes nothing",
    )
    .action(async function (this: Command) {
      const answer = await storeInfo(environmentOf(this).env ?? process.env)
      renderAnswer(this, outputFor(this), itemOf(answer))
    })

/** `store info` for a tool with no `store` command of its own. */
export const sharedStoreCommand = (): Command =>
  new Command("store").description("the shared local store every WireCat tool reads").addCommand(storeInfoCommand())
