import assert from "node:assert/strict"
import { createMeetingManagement, type MeetingManagementPorts } from "../meeting-management.js"
import type { MeetingProviderScope } from "../provider.js"
import type { ContractCase } from "../store.js"

export interface MeetingManagementContractFixture {
  scope: MeetingProviderScope
  ports: MeetingManagementPorts
  id: string
}

/** Factories must use invented fixtures and injected transports; cases can apply writes. */
export const meetingManagementContract = (
  make: () => MeetingManagementContractFixture | Promise<MeetingManagementContractFixture>,
): ContractCase[] => {
  const test = (name: string, check: (fixture: MeetingManagementContractFixture) => Promise<void>): ContractCase => ({
    name,
    async run() {
      await check(await make())
    },
  })
  return [
    test("management previews perform no provider work", async ({ scope, ports, id }) => {
      const fail = assert.fail as (...args: unknown[]) => never
      const sdk = createMeetingManagement(scope, {
        ...(ports.create ? { create: fail } : {}),
        ...(ports.update ? { update: fail } : {}),
        ...(ports.cancel ? { cancel: fail } : {}),
      })
      if (ports.create) {
        const receipt = await sdk.create({ title: "Alice Example planning", kind: "instant" })
        assert.equal(receipt.applied, false)
        assert.deepEqual(receipt.scope, scope)
      }
      if (ports.update) assert.equal((await sdk.update(id, { agenda: "Bob Sample agenda" })).applied, false)
      if (ports.cancel) assert.equal((await sdk.cancel(id, { apply: true, dryRun: true })).applied, false)
    }),
    test("management dispatches one explicit create with fixed scope", async ({ scope, ports }) => {
      const create = ports.create
      if (!create) return
      let calls = 0
      const sdk = createMeetingManagement(scope, {
        create: async (change, context) => {
          calls++
          assert.deepEqual(context.scope, scope)
          assert.equal(Object.isFrozen(context.scope), true)
          return create(change, context)
        },
      })
      const receipt = await sdk.create({ title: "Alice Example planning", kind: "instant" }, { apply: true })
      assert.equal(calls, 1)
      assert.equal(receipt.applied, true)
      assert.ok(receipt.meeting?.id)
    }),
    test("management cancellation reaches no provider port", async ({ scope, ports, id }) => {
      const controller = new AbortController()
      controller.abort()
      const fail = assert.fail as (...args: unknown[]) => never
      const sdk = createMeetingManagement(scope, { ...ports, ...(ports.list ? { list: fail } : {}) })
      if (ports.list) assert.throws(() => sdk.list({ signal: controller.signal }), { code: "cancelled" })
      if (ports.cancel)
        await assert.rejects(sdk.cancel(id, { apply: true, signal: controller.signal }), { code: "cancelled" })
    }),
    test("management dispatches explicit update and cancel once with opaque ids", async ({ scope, ports, id }) => {
      const update = ports.update
      const cancel = ports.cancel
      let updates = 0
      let cancellations = 0
      const sdk = createMeetingManagement(scope, {
        ...(update
          ? {
              update: async (meetingId, change, context) => {
                updates++
                assert.equal(meetingId, id)
                assert.deepEqual(context.scope, scope)
                await update(meetingId, change, context)
              },
            }
          : {}),
        ...(cancel
          ? {
              cancel: async (meetingId, context) => {
                cancellations++
                assert.equal(meetingId, id)
                assert.deepEqual(context.scope, scope)
                await cancel(meetingId, context)
              },
            }
          : {}),
      })
      if (update) {
        assert.equal((await sdk.update(id, { agenda: "Bob Sample agenda" }, { apply: true })).applied, true)
        assert.equal(updates, 1)
      }
      if (cancel) {
        assert.equal((await sdk.cancel(id, { apply: true })).applied, true)
        assert.equal(cancellations, 1)
      }
    }),
  ]
}
