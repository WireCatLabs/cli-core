import { createHash } from "node:crypto"
import { appendFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { scratch } from "./scratch.ts"

export const checkRecordingPartials = async (dist: string): Promise<void> => {
  const { NativeRecordingPartialStore } = await import(join(dist, "persistence/native/index.js"))
  const { transferRecording } = await import(join(dist, "meetings/index.js"))
  const folder = scratch("core-dist-partial-")
  const locator = { provider: "example-calls", account: "alice", occurrenceId: "weekly", assetId: "audio" }
  const settings = { prefix: ".example-partial-", persistent: true, maxBytes: 100 }
  const first = new NativeRecordingPartialStore(folder, locator, settings)
  const writer = await first.open(locator, { validator: '"example-v1"', total: 6 })
  try {
    await writer.write(Buffer.from("abc"))
    await writer.checkpoint()
  } finally {
    await writer.close()
  }
  await appendFile(first.path, "uncommitted")
  const next = new NativeRecordingPartialStore(folder, locator, settings)
  const result = await transferRecording(
    {
      open: async (request: { offset?: number; validator?: string }) => {
        if (request.offset !== 3 || request.validator !== '"example-v1"')
          throw new Error("dist partial resume mismatch")
        return {
          status: 206,
          etag: '"example-v1"',
          contentRange: "bytes 3-5/6",
          contentLength: "3",
          body: (async function* () {
            yield Buffer.from("def")
          })(),
          close: async () => {},
        }
      },
    },
    next,
    { locator, maxBytes: 100 },
  )
  if (
    result.resumedBytes !== 3 ||
    result.size !== 6 ||
    result.sha256 !== createHash("sha256").update("abcdef").digest("hex") ||
    (await readFile(next.path, "utf8")) !== "abcdef"
  )
    throw new Error("dist partial receipt mismatch")
  console.log("dist: ./persistence/native resumes verified prefixes through the portable transfer service")
}
