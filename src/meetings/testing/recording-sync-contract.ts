import assert from "node:assert/strict"
import type { RecordingSyncCheckpoint, RecordingSyncCheckpointStore } from "../recording-sync.js"
import type { ContractCase } from "../store.js"

export interface RecordingSyncCheckpointFixture {
  store: RecordingSyncCheckpointStore
  reopen(): Promise<RecordingSyncCheckpointStore>
}
export function recordingSyncCheckpointStoreContract(
  make: () => RecordingSyncCheckpointFixture | Promise<RecordingSyncCheckpointFixture>,
): ContractCase[] {
  const state = (revision = 1): RecordingSyncCheckpoint => ({
    version: 1,
    scope: { provider: "example-video", account: "AliceExample" },
    configKey: "example-destination-and-policy",
    revision,
    updatedAt: 1000,
    windows: [],
    pendingWindows: [{ from: "2026-01-01", to: "2026-01-31" }],
    entries: [],
  })
  return [
    {
      name: "archive checkpoint starts empty under an exclusive lease",
      async run() {
        const { store } = await make()
        const lease = await store.acquire("AliceExample")
        try {
          assert.equal(await store.read("AliceExample", lease.token), null)
          await assert.rejects(store.acquire("AliceExample"))
          await assert.rejects(store.read("AliceExample", "foreign-lease"))
          await assert.rejects(store.read("BobSample", lease.token))
        } finally {
          await lease.release()
        }
      },
    },
    {
      name: "archive checkpoint persists acknowledged metadata across reopen",
      async run() {
        const fixture = await make()
        const lease = await fixture.store.acquire("AliceExample")
        const value = state()
        try {
          await fixture.store.save("AliceExample", lease.token, null, value)
        } finally {
          await lease.release()
        }
        value.configKey = "caller-mutation"
        const reopened = await fixture.reopen()
        const second = await reopened.acquire("AliceExample")
        try {
          assert.deepEqual(await reopened.read("AliceExample", second.token), state())
        } finally {
          await second.release()
        }
      },
    },
    {
      name: "archive checkpoint compare-and-save rejects stale and nonsequential revisions",
      async run() {
        const { store } = await make()
        const lease = await store.acquire("AliceExample")
        try {
          await store.save("AliceExample", lease.token, null, state())
          await assert.rejects(store.save("AliceExample", lease.token, null, state(2)))
          await assert.rejects(store.save("AliceExample", lease.token, 1, state(3)))
          await store.save("AliceExample", lease.token, 1, state(2))
          assert.deepEqual(await store.read("AliceExample", lease.token), state(2))
        } finally {
          await lease.release()
        }
      },
    },
    {
      name: "archive checkpoint released leases cannot read or write",
      async run() {
        const { store } = await make()
        const lease = await store.acquire("AliceExample")
        await lease.release()
        await assert.rejects(store.read("AliceExample", lease.token))
        await assert.rejects(store.save("AliceExample", lease.token, null, state()))
        const next = await store.acquire("AliceExample")
        try {
          assert.notEqual(next.token, lease.token)
          assert.equal(await store.read("AliceExample", next.token), null)
        } finally {
          await next.release()
        }
      },
    },
  ]
}
