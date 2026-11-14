import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { meetingDetailsAnswer, meetingItem, pull, type SourceParticipant } from "../meetings/index.js"

import { fakeMeetingSource } from "../meetings/testing/index.js"
import { type MessageStore, openStore } from "../store/store.js"
import { canonicalPersonContext } from "./person-business.js"

const CALLS = { provider: "pbx-example", account: "office", scope: "work" as const }

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const participant = (role: string, fields: Partial<SourceParticipant>): SourceParticipant => ({
  identityExternalId: null,
  email: null,
  displayName: null,
  externalId: null,
  role,
  joinedAt: null,
  leftAt: null,
  durationMs: null,
  sessions: null,
  metadata: null,
  ...fields,
})

const occurrence = (id: string) => ({
  id,
  seriesId: id,
  title: `Call ${id}`,
  startedAt: "2026-11-13T10:00:00.000Z",
  endedAt: "2026-11-13T10:05:00.000Z",
})

const fixture = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "call-fields-")), "store.db") })
  opened.push(store)
  const accountId = await store.accounts.saveAccount(CALLS, { name: null })
  const source = fakeMeetingSource({
    provider: CALLS.provider,
    meetings: async () => [
      { series: null, occurrence: occurrence("call-1"), call: { direction: "in", clientPhone: "+79161234567" } },
      { series: null, occurrence: occurrence("meeting-2") },
    ],
    participants: async (id) =>
      id === "call-1"
        ? [
            participant("manager", { identityExternalId: "abonent:olga", displayName: "Olga Example" }),
            participant("client", { identityExternalId: "phone:+79161234567", phone: "+79161234567" }),
          ]
        : [],
    transcript: async () => null,
  })
  await pull(source, { ...store.meetings, linkCallers: undefined }, { accountId, now: Date.parse("2026-11-14") })
  return { store, accountId }
}

describe("a phone call's fields on its meeting", () => {
  it("are what the source set, in meetings list and show, and absent on a meeting", async () => {
    const { store, accountId } = await fixture()
    const manager = await store.people.personOf({ provider: CALLS.provider, id: "abonent:olga" })
    const call = {
      direction: "in",
      manager: { name: "Olga Example", person: `person:${manager?.uid}` },
      client_phone: "+79161234567",
    }

    const list = (await store.meetings.meetings({ accountId })).map((row) =>
      meetingItem(row, { provider: CALLS.provider, account: CALLS.account }),
    )
    const byTitle = Object.fromEntries(list.map((item) => [item.title, item]))
    expect(byTitle["Call call-1"]?.call).toEqual(call)
    expect(byTitle["Call meeting-2"]).not.toHaveProperty("call")
    const id = Number(byTitle["Call call-1"]?.id)
    expect((await meetingDetailsAnswer(store.meetings, id, accountId)).item.call).toEqual(call)
  })

  it("are on the call in a person's context", async () => {
    const { store } = await fixture()
    const client = await store.people.personOf({ provider: CALLS.provider, id: "phone:+79161234567" })

    const context = await canonicalPersonContext(store, `person:${client?.uid}`)

    expect(context.meetings).toMatchObject([{ call: { direction: "in", client_phone: "+79161234567" } }])
  })

  it("refuses a direction other than in or out", async () => {
    const { store, accountId } = await fixture()
    await expect(
      store.meetings.saveMeeting({
        meeting: {
          accountId,
          externalId: "bad",
          title: null,
          description: null,
          location: null,
          joinUrl: null,
          startedAt: null,
          endedAt: null,
          durationMs: null,
          timezone: null,
          hostIdentityId: null,
          metadata: null,
          deletedAt: null,
          direction: "sideways" as never,
        },
        now: 1,
      }),
    ).rejects.toThrow("direction")
  })
})
