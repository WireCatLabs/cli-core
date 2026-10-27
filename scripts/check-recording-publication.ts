import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { scratch } from "./scratch.ts"

export const checkRecordingPublication = async (dist: string): Promise<void> => {
  const { NativeRecordingPublication } = await import(join(dist, "persistence/native/index.js"))
  const root = scratch("core-dist-publication-")
  const locator = { provider: "example-calls", account: "alice", occurrenceId: "weekly", assetId: "audio" }
  const evidence = { size: 6, sha256: createHash("sha256").update("abcdef").digest("hex"), validator: '"v1"' }
  const publication = new NativeRecordingPublication(root, locator, {
    prefix: ".example-promotion-",
    filename: "audio.bin",
    maxBytes: 100,
    metadataLimit: 1024,
    codec: {
      encode: JSON.stringify,
      decode: (value: unknown) => {
        const record = value as typeof evidence
        if (record?.sha256 !== evidence.sha256 || record.validator !== evidence.validator || record.size !== 6)
          throw new Error("dist publication journal mismatch")
        return record
      },
    },
    evidence: (value: typeof evidence) => value,
  })
  const partial = join(root, "owned.part")
  await writeFile(partial, "abcdef")
  await publication.write(evidence)
  const interrupted = new Error("example manifest interruption")
  try {
    await publication.publish(partial, evidence, async () => {
      throw interrupted
    })
    throw new Error("dist publication swallowed manifest interruption")
  } catch (error) {
    if (error !== interrupted) throw error
  }
  let committed = false
  await publication.recover(
    partial,
    async () => ({ locator, offset: 6, sha256: evidence.sha256, validator: evidence.validator, total: 6 }),
    async () => {
      committed = true
    },
  )
  if (!committed || (await readFile(publication.finalPath, "utf8")) !== "abcdef")
    throw new Error("dist publication recovery mismatch")
  console.log("dist: ./persistence/native recovers verified publication through a fictional host codec")
}
