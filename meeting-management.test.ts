import { CliError } from "@wirecat/cli-core"
import { describe, expect, it } from "vitest"
import {
  createMeetingManagement,
  dispatchMeetingMutation,
  type ManagedMeeting,
  type ManagedMeetingChange,
  type MeetingManagementPorts,
  validateMeetingChange,
} from "./meeting-management.js"
import { snapshotMeetingScope } from "./provider.js"
import { meetingManagementContract } from "./testing/management-contract.js"

const meeting = (id: string): ManagedMeeting => ({
  id,
  title: "Alice Example planning",
  kind: "scheduled",
  startTime: "2026-10-11T10:00:00Z",
  durationMinutes: 30,
  timezone: "Europe/Madrid",
  agenda: "Bob Sample agenda",
  joinUrl: null,
})

const providers = [
  { scope: { provider: "example-calendar", account: "alice@example.invalid" }, id: "opaque/meeting:a", writable: true },
  { scope: { provider: "sample-assistant", account: "Bob Sample workspace" }, id: "{opaque-uuid}", writable: false },
]
for (const fixture of providers) {
  const make = () => ({
    scope: { ...fixture.scope },
    id: fixture.id,
    ports: {
      list: async () => [meeting(fixture.id)],
      get: async (id: string) => meeting(id),
      ...(fixture.writable
        ? {
            invitation: async (id: string) => ({ id, invitation: "Alice Example invitation" }),
            create: async () => meeting(fixture.id),
            update: async () => {},
            cancel: async () => {},
          }
        : {}),
    },
  })
  describe(fixture.scope.provider, () => {
    for (const contract of meetingManagementContract(make)) it(contract.name, contract.run)
    it("keeps opaque ids and optional capability composition", async () => {
      const sdk = createMeetingManagement(fixture.scope, make().ports)
      expect(await sdk.list()).toEqual([meeting(fixture.id)])
      expect(await sdk.get(fixture.id)).toEqual(meeting(fixture.id))
      expect(sdk.capabilities).toContain("get")
      if (fixture.writable) {
        expect(await sdk.invitation(fixture.id)).toEqual({ id: fixture.id, invitation: "Alice Example invitation" })
        expect(await sdk.update(fixture.id, { title: "Bob Sample" }, { apply: true })).toMatchObject({
          applied: true,
          id: fixture.id,
        })
        expect(await sdk.cancel(fixture.id, { occurrenceId: "opaque/occurrence", apply: true })).toMatchObject({
          applied: true,
          occurrenceId: "opaque/occurrence",
        })
        expect(await sdk.cancel(fixture.id)).toMatchObject({ applied: false })
      } else {
        await expect(sdk.create({ title: "Example", kind: "instant" })).rejects.toMatchObject({
          code: "provider_unavailable",
        })
        await expect(sdk.update(fixture.id, { title: "Example" })).rejects.toMatchObject({
          code: "provider_unavailable",
        })
        await expect(sdk.cancel(fixture.id)).rejects.toMatchObject({ code: "provider_unavailable" })
        expect(() => sdk.invitation(fixture.id)).toThrow(/does not support/)
      }
    })
  })
}

it("snapshots provider, account, capabilities and change before asynchronous work", async () => {
  const scope = { provider: "example-provider", account: "Alice Example" }
  const change: ManagedMeetingChange = { title: "Alice Example", kind: "instant" }
  const options = { apply: true, account: "foreign account", provider: "foreign provider" }
  let unblock = () => {}
  const gate = new Promise<void>((resolve) => {
    unblock = resolve
  })
  const ports: MeetingManagementPorts = {
    create: async (input, context) => {
      await gate
      expect(context.scope).toEqual({ provider: "example-provider", account: "Alice Example" })
      expect(input).toEqual({ title: "Alice Example", kind: "instant" })
      return meeting("opaque-example")
    },
  }
  const sdk = createMeetingManagement(scope, ports)
  const pending = sdk.create(change, options)
  scope.account = "Bob Sample"
  scope.provider = "other"
  change.title = "Changed after dispatch"
  ports.create = async () => {
    throw new Error("replacement should not run")
  }
  options.apply = false
  unblock()
  expect(await pending).toMatchObject({ applied: true, meeting: { id: "opaque-example" } })
})

it("propagates uncertain mutation outcomes without retry or cancellation rewriting", async () => {
  const abort = new AbortController()
  const uncertain = new CliError("outcome_unknown", "verify provider state before retrying")
  let calls = 0
  const sdk = createMeetingManagement(
    { provider: "example-calendar", account: "alice@example.invalid" },
    {
      create: async () => {
        calls++
        abort.abort()
        throw uncertain
      },
    },
  )
  await expect(sdk.create({ title: "Example", kind: "instant" }, { apply: true, signal: abort.signal })).rejects.toBe(
    uncertain,
  )
  expect(calls).toBe(1)
})

it("preserves acknowledged writes when cancellation follows provider acknowledgement", async () => {
  const abort = new AbortController()
  expect(
    await dispatchMeetingMutation({ apply: true, signal: abort.signal }, async () => {
      abort.abort()
      return "acknowledged"
    }),
  ).toEqual({ applied: true, value: "acknowledged" })
})

it("validates calendar timestamps, portable description, duration and timezone without provider work", () => {
  expect(
    validateMeetingChange(
      {
        title: "Example",
        startTime: "2026-10-11T12:00:00+02:00",
        timezone: "Europe/Madrid",
        durationMinutes: 1440,
        agenda: "",
      },
      true,
    ),
  ).toEqual({
    title: "Example",
    kind: "scheduled",
    startTime: "2026-10-11T10:00:00.000Z",
    timezone: "Europe/Madrid",
    durationMinutes: 1440,
    agenda: "",
  })
  expect(validateMeetingChange({ kind: "scheduled" }, false)).toEqual({ kind: "scheduled" })
  expect(validateMeetingChange({ title: "Example", kind: "instant" }, true)).toEqual({
    title: "Example",
    kind: "instant",
  })
  for (const value of [
    null,
    [],
    { settings: {} },
    { title: " " },
    { kind: "recurring" },
    { title: "Example" },
    { title: "Example", startTime: "bad" },
    { title: "Example", startTime: "2026-02-30T12:00:00Z" },
    { title: "Example", startTime: "2026-02-30T12:00:00+23:59" },
    { title: "Example", startTime: "2026-10-11T12:00:00" },
    { durationMinutes: 0 },
    { durationMinutes: 1441 },
    { durationMinutes: 1.5 },
    { timezone: "" },
    { timezone: 5 },
    { timezone: "Invalid/Example" },
    { agenda: 5 },
  ])
    expect(() => validateMeetingChange(value as ManagedMeetingChange, true)).toThrow()
  for (const value of [
    { durationMinutes: 0 },
    { timezone: "" },
    { timezone: 5 },
    { timezone: "Invalid/Example" },
    { agenda: 5 },
    { kind: "recurring" },
    { durationMinutes: 1441 },
    { durationMinutes: 1.5 },
    {},
  ])
    expect(() => validateMeetingChange(value as ManagedMeetingChange, false)).toThrow()
})

it("rejects invalid scope and ids before provider work without normalizing identity", async () => {
  const fail = async () => {
    throw new Error("unexpected provider call")
  }
  expect(snapshotMeetingScope({ provider: " Provider ", account: " Account " })).toEqual({
    provider: " Provider ",
    account: " Account ",
  })
  for (const value of [
    null,
    {},
    { provider: "", account: "Example" },
    { provider: "Example", account: "" },
    { provider: "x".repeat(201), account: "Example" },
    { provider: "Example", account: "x".repeat(1001) },
    { provider: "Example\n", account: "Example" },
    { provider: "Example", account: "Example\0" },
    { provider: 5, account: "Example" },
    { provider: "Example", account: 5 },
  ])
    expect(() => snapshotMeetingScope(value as (typeof providers)[0]["scope"])).toThrow()
  const sdk = createMeetingManagement(
    { provider: "example-calendar", account: "alice@example.invalid" },
    { get: fail, update: fail, cancel: fail },
  )
  expect(() => sdk.get(" ")).toThrow(/nonempty/)
  await expect(sdk.update("", { title: "Example" })).rejects.toThrow(/nonempty/)
  await expect(sdk.cancel("", { apply: true })).rejects.toThrow(/nonempty/)
  await expect(sdk.cancel("id", { occurrenceId: " " })).rejects.toThrow(/nonempty/)
  expect(() =>
    createMeetingManagement({ provider: "example-calendar", account: "alice@example.invalid" }, {}).list(),
  ).toThrow(/does not support/)
})

it("fails before dispatch on cancellation, timeout, and caller cancellation error", async () => {
  for (const reason of [
    undefined,
    new DOMException("Example timeout", "TimeoutError"),
    new CliError("cancelled", "Example cancellation"),
  ]) {
    const controller = new AbortController()
    controller.abort(reason)
    await expect(
      dispatchMeetingMutation({ apply: true, signal: controller.signal }, async () => {
        throw new Error("unexpected dispatch")
      }),
    ).rejects.toMatchObject({ code: reason?.name === "TimeoutError" ? "timeout" : "cancelled" })
  }
  expect(await dispatchMeetingMutation({}, async () => "unexpected")).toEqual({ applied: false })
  expect(await dispatchMeetingMutation({ apply: 1 as unknown as boolean }, async () => "unexpected")).toEqual({
    applied: false,
  })
  expect(await dispatchMeetingMutation({ apply: true, dryRun: true }, async () => "unexpected")).toEqual({
    applied: false,
  })
})

for (const contract of meetingManagementContract(() => ({
  scope: { provider: "example-no-management", account: "Alice Example" },
  ports: {},
  id: "example-id",
})))
  it(`no management capability: ${contract.name}`, contract.run)
