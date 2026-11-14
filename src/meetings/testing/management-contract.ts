import assert from "node:assert/strict"
import {
  createMeetingManagement,
  type DeclaredMeetingFields,
  declareMeetingFields,
  type ManagedMeetingChange,
  type MeetingManagementPorts,
  type MeetingSetting,
} from "../meeting-management.js"
import type { MeetingProviderScope } from "../provider.js"
import type { ContractCase } from "../store.js"

export interface MeetingManagementContractFixture {
  scope: MeetingProviderScope
  ports: MeetingManagementPorts
  id: string
}

const sampleSetting = (setting: MeetingSetting): string | boolean =>
  setting.type === "choice" ? (setting.values[0] as string) : setting.type === "boolean" ? true : "Bob Sample note"

/** A change that uses only what the port declares, so a service without a title or an agenda is checked too. */
const sampleChange = (declared: DeclaredMeetingFields, create: boolean): ManagedMeetingChange => {
  const has = (field: (typeof declared.fields)[number]) => declared.fields.includes(field)
  const first = declared.settings[0]
  const settings = first ? { settings: { [first.name]: sampleSetting(first) } } : {}
  if (create)
    return {
      ...(has("title") ? { title: "Alice Example planning" } : {}),
      ...(has("kind") ? { kind: "instant" as const } : has("startTime") ? { startTime: "2026-11-20T10:00:00Z" } : {}),
      ...settings,
    }
  if (has("agenda")) return { agenda: "Bob Sample agenda" }
  if (has("title")) return { title: "Alice Example planning" }
  return settings
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
        ...(ports.fields ? { fields: ports.fields } : {}),
      })
      if (ports.create) {
        const receipt = await sdk.create(sampleChange(sdk.fields.create, true))
        assert.equal(receipt.applied, false)
        assert.deepEqual(receipt.scope, scope)
      }
      if (ports.update) assert.equal((await sdk.update(id, sampleChange(sdk.fields.update, false))).applied, false)
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
        ...(ports.fields ? { fields: ports.fields } : {}),
      })
      const receipt = await sdk.create(sampleChange(sdk.fields.create, true), { apply: true })
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
        ...(ports.fields ? { fields: ports.fields } : {}),
      })
      if (update) {
        const change = sampleChange(declareMeetingFields(ports.fields?.update, "update"), false)
        assert.equal((await sdk.update(id, change, { apply: true })).applied, true)
        assert.equal(updates, 1)
      }
      if (cancel) {
        assert.equal((await sdk.cancel(id, { apply: true })).applied, true)
        assert.equal(cancellations, 1)
      }
    }),
  ]
}
