import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import type { RecordingAssetLocator } from "../recording-source.js"
import type { RecordingTransferStorage } from "../recording-transfer.js"
import type { ContractCase } from "../store.js"

export interface RecordingTransferStorageFixture {
  storage: RecordingTransferStorage
  reopen(): Promise<RecordingTransferStorage>
}
/** Each case gets a fresh scoped backend. Reopen retains only durable state. */
export const recordingTransferStorageContract = (
  make: (locator: RecordingAssetLocator) => RecordingTransferStorageFixture | Promise<RecordingTransferStorageFixture>,
): ContractCase[] => {
  const locator = {
    provider: "example-video",
    account: "AliceExample",
    occurrenceId: "example-occurrence",
    assetId: "example-asset",
  }
  const bytes = new TextEncoder().encode("example video")
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  return [
    {
      name: "recording transfer storage starts empty",
      run: async () => {
        const fixture = await make(locator)
        assert.equal(await fixture.storage.load(locator), null)
      },
    },
    {
      name: "recording transfer storage persists a verified prefix across reopen",
      run: async () => {
        const fixture = await make(locator)
        const writer = await fixture.storage.open(locator, { validator: '"example-v1"', total: bytes.length })
        try {
          await writer.write(bytes)
          await writer.checkpoint()
        } finally {
          await writer.close()
        }
        const storage = await fixture.reopen()
        const partial = await storage.load(locator)
        assert.deepEqual(partial, {
          locator,
          offset: bytes.length,
          sha256,
          validator: '"example-v1"',
          total: bytes.length,
        })
        assert.ok(partial)
        const resumed = await storage.open(locator, {
          resume: partial,
          validator: partial.validator,
          total: partial.total,
        })
        try {
          assert.deepEqual(await resumed.finish(), { size: bytes.length, sha256 })
        } finally {
          await resumed.close()
        }
      },
    },
    {
      name: "recording transfer storage restart replaces the prefix",
      run: async () => {
        const fixture = await make(locator)
        const writer = await fixture.storage.open(locator, { validator: '"old"', total: 100 })
        try {
          await writer.write(bytes)
          await writer.checkpoint()
        } finally {
          await writer.close()
        }
        const replacement = await fixture.storage.open(locator, { validator: '"new"', total: 3 })
        try {
          await replacement.write(new TextEncoder().encode("new"))
          const result = await replacement.finish()
          assert.equal(result.size, 3)
          assert.equal(result.sha256, createHash("sha256").update("new").digest("hex"))
        } finally {
          await replacement.close()
        }
        assert.equal((await (await fixture.reopen()).load(locator))?.validator, '"new"')
      },
    },
  ]
}
