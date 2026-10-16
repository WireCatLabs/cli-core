import { createHash } from "node:crypto"
import { copyFile, link, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import type { RecordingPartial } from "../../meetings/index.js"
import { NativeRecordingPublication } from "./index.js"

const locator = { provider: "sample-calls", account: "alice", occurrenceId: "weekly", assetId: "audio" }
const sha256 = createHash("sha256").update("abcdef").digest("hex")
const evidence = { size: 6, sha256, validator: '"v1"' }
const checkpoint: RecordingPartial = { locator, offset: 6, sha256, validator: '"v1"', total: 6 }
interface Intent {
  version: number
  owner: string
  result: typeof evidence
}
const intent: Intent = { version: 1, owner: "alice", result: evidence }
const codec = {
  encode: (value: Intent) => JSON.stringify(value),
  decode: (value: unknown): Intent => {
    const record = value as Intent
    if (record?.version !== 1 || record.owner !== "alice" || !record.result) throw new Error("foreign intent")
    return record
  },
}
const setup = async (signal?: AbortSignal) => {
  const root = await mkdtemp(join(tmpdir(), "cli-messaging-test-publication-"))
  const publication = new NativeRecordingPublication(root, locator, {
    prefix: ".sample-intent-",
    filename: "audio.bin",
    maxBytes: 100,
    metadataLimit: 1024,
    codec,
    evidence: (value) => value.result,
    signal,
  })
  const partial = join(root, "owned.part")
  await writeFile(partial, "abcdef")
  return { root, publication, partial }
}

it("publishes a fictional provider through a host codec and durably commits before removing its partial", async () => {
  const { publication, partial, root } = await setup()
  await publication.write(intent)
  expect(await readFile(publication.journalPath, "utf8")).toBe(JSON.stringify(intent))
  const commit = vi.fn(async () => {
    expect(await readFile(partial, "utf8")).toBe("abcdef")
    expect(await readFile(publication.finalPath, "utf8")).toBe("abcdef")
    await writeFile(join(root, "receipt.json"), JSON.stringify(evidence))
  })
  await publication.publish(partial, evidence, commit)
  expect(commit).toHaveBeenCalledOnce()
  expect(await readdir(root)).not.toContain("owned.part")
  expect(await publication.read()).toEqual(intent)
})

it("recovers independently written legacy bytes without rewriting or downloading the final", async () => {
  const { publication, partial } = await setup()
  await writeFile(
    publication.journalPath,
    '{"version":1,"owner":"alice","result":{"size":6,"sha256":"bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721","validator":"\\"v1\\""}}',
  )
  await link(partial, publication.finalPath)
  const commit = vi.fn(async (value: Intent) => {
    expect(value).toEqual(intent)
  })
  await expect(publication.recover(partial, async () => checkpoint, commit)).resolves.toEqual(intent)
  expect(commit).toHaveBeenCalledOnce()
  expect(await readFile(publication.finalPath, "utf8")).toBe("abcdef")
})

it("never overwrites an unrelated final or commits an unverified partial", async () => {
  const { publication, partial } = await setup()
  const commit = vi.fn(async () => {})
  await writeFile(publication.finalPath, "foreign")
  await expect(publication.publish(partial, evidence, commit)).rejects.toMatchObject({ code: "EEXIST" })
  expect(await readFile(publication.finalPath, "utf8")).toBe("foreign")
  await expect(publication.publish(partial, { ...evidence, sha256: "0".repeat(64) }, commit)).rejects.toThrow(
    "checksum",
  )
  expect(commit).not.toHaveBeenCalled()
})

it("retains evidence when commitment fails and recovers on a later invocation", async () => {
  const { publication, partial } = await setup()
  await publication.write(intent)
  await expect(
    publication.publish(partial, evidence, async () => {
      throw new Error("commit interrupted")
    }),
  ).rejects.toThrow("commit interrupted")
  expect(await readFile(partial, "utf8")).toBe("abcdef")
  await publication.recover(
    partial,
    async () => checkpoint,
    async () => {},
  )
  await expect(readFile(partial)).rejects.toMatchObject({ code: "ENOENT" })
})

it.each([
  { ...checkpoint, locator: { ...locator, account: "bob" } },
  { ...checkpoint, offset: 5 },
  { ...checkpoint, sha256: "0".repeat(64) },
  { ...checkpoint, validator: '"v2"' },
  { ...checkpoint, total: 7 },
  null,
])("refuses recovery without matching completed checkpoint %#", async (completed) => {
  const { publication, partial } = await setup()
  await publication.write(intent)
  await link(partial, publication.finalPath)
  const commit = vi.fn(async () => {})
  await expect(publication.recover(partial, async () => completed, commit)).rejects.toThrow("checkpoint")
  expect(commit).not.toHaveBeenCalled()
  expect(await readFile(partial, "utf8")).toBe("abcdef")
})

it("checks both the partial and final bytes and refuses weak validators", async () => {
  const { publication, partial } = await setup()
  await publication.write(intent)
  await copyFile(partial, publication.finalPath)
  const commit = vi.fn(async () => {})
  await writeFile(publication.finalPath, "xxxxxx")
  await expect(publication.recover(partial, async () => checkpoint, commit)).rejects.toThrow("checksum")
  await writeFile(publication.finalPath, "abcdef")
  await writeFile(partial, "xxxxx")
  await expect(publication.recover(partial, async () => checkpoint, commit)).rejects.toThrow("checksum")
  await publication.write({ ...intent, result: { ...evidence, validator: 'W/"weak"' } })
  await expect(publication.recover(partial, async () => checkpoint, commit)).rejects.toThrow("checkpoint")
  expect(commit).not.toHaveBeenCalled()
})

it("bounds and validates journals and refuses absent or foreign intent", async () => {
  const { publication, partial } = await setup()
  expect(await publication.read()).toBeNull()
  await expect(
    publication.recover(
      partial,
      async () => checkpoint,
      async () => {},
    ),
  ).rejects.toThrow("recovery record")
  for (const value of ["x".repeat(1025), "{", "null", JSON.stringify({ ...intent, owner: "bob" })]) {
    await writeFile(publication.journalPath, value)
    await expect(publication.read()).rejects.toThrow("recovery record")
  }
  await expect(publication.write({ ...intent, owner: "x".repeat(2000) })).rejects.toThrow("metadata limit")
})

it("rejects symlinks at the journal, partial and final without touching their targets", async () => {
  const first = await setup()
  const second = await setup()
  await symlink(first.partial, second.publication.journalPath)
  await expect(second.publication.read()).rejects.toThrow("symlink")
  await symlink(first.partial, first.publication.finalPath)
  await first.publication.write(intent)
  await expect(
    first.publication.recover(
      first.partial,
      async () => checkpoint,
      async () => {},
    ),
  ).rejects.toThrow("symlink")
  const alias = join(second.root, "alias.part")
  await symlink(first.partial, alias)
  await expect(second.publication.publish(alias, evidence, async () => {})).rejects.toThrow("symlink")
  expect(await readFile(first.partial, "utf8")).toBe("abcdef")
})

it("propagates cancellation before publication and after commitment without false success", async () => {
  const controller = new AbortController()
  const { publication, partial } = await setup(controller.signal)
  await publication.write(intent)
  await expect(
    publication.publish(partial, evidence, async () => {
      controller.abort(new Error("example cancel"))
    }),
  ).rejects.toThrow("example cancel")
  expect(await readFile(partial, "utf8")).toBe("abcdef")
  await expect(publication.read()).rejects.toThrow("example cancel")
  await expect(publication.write(intent)).rejects.toThrow("example cancel")
})

it("validates native layout and evidence before touching files", async () => {
  const { root, publication, partial } = await setup()
  const options = {
    prefix: ".sample-",
    filename: "audio.bin",
    maxBytes: 100,
    metadataLimit: 1024,
    codec,
    evidence: (value: Intent) => value.result,
  }
  for (const invalid of [
    { filename: "../outside" },
    { prefix: "../bad-" },
    { maxBytes: 0 },
    { metadataLimit: 1048577 },
  ])
    expect(() => new NativeRecordingPublication(root, locator, { ...options, ...invalid })).toThrow("options")
  for (const invalid of [
    { size: -1, sha256 },
    { size: 101, sha256 },
    { size: 6, sha256: "invalid" },
  ])
    await expect(publication.publish(partial, invalid, async () => {})).rejects.toThrow("evidence")
  await expect(publication.publish(join(root, "..", "foreign.part"), evidence, async () => {})).rejects.toThrow(
    "evidence",
  )
  await expect(publication.publish(publication.finalPath, evidence, async () => {})).rejects.toThrow("evidence")
})
