import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { pull, type SourceParticipant } from "../meetings/index.js"
import { fakeMeetingSource } from "../meetings/testing/index.js"
import { type MessageStore, openStore } from "../store/store.js"
import { personMeetingContext } from "./person-meeting-context.js"

const CRM = { provider: "bitrix24", account: "acme.example", scope: "work" as const }
const CALLS = { provider: "pbx-example", account: "office", scope: "work" as const }

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const client = (phone: string): SourceParticipant => ({
  identityExternalId: `phone:${phone}`,
  phone,
  email: null,
  displayName: null,
  externalId: null,
  role: "client",
  joinedAt: null,
  leftAt: null,
  durationMs: null,
  sessions: null,
  metadata: null,
})

const fixture = async (contacts: { id: string; name: string; phone: string }[], called: string) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "phone-link-")), "store.db") })
  opened.push(store)
  await store.accounts.saveAccount(CRM, { name: null })
  const accountId = await store.accounts.saveAccount(CALLS, { name: null })
  await store.people.savePeople(CRM, contacts)
  const source = fakeMeetingSource({ provider: CALLS.provider, participants: async () => [client(called)] })
  await pull(source, store.meetings, { accountId, now: 4000 })
  const scan = await store.people.scanMatches()
  const callPerson = await store.people.personOf({ provider: CALLS.provider, id: `phone:${called}` })
  const contactPerson = await store.people.personOf({ provider: CRM.provider, id: contacts[0]?.id as string })
  return { store, accountId, scan, callPerson, contactPerson }
}

describe("a call's client and the CRM contact with that number (NEED-2600)", () => {
  it("are one person, and the call is in that person's meeting context", async () => {
    const { store, accountId, scan, callPerson, contactPerson } = await fixture(
      [{ id: "contact/20", name: "Ana Example", phone: "+7 (916) 123-45-67" }],
      "+79161234567",
    )

    expect(scan.merged).toMatchObject([{ signal: "same-phone" }])
    expect(callPerson?.uid).toBe(contactPerson?.uid)
    expect(callPerson?.identities.map(({ provider }) => provider).sort()).toEqual([CRM.provider, CALLS.provider])
    const context = await personMeetingContext(store, `person:${callPerson?.uid}`, { accountIds: [accountId] })
    expect(context.person.name).toBe("Ana Example")
    expect(context.items.map(({ reference }) => reference)).toEqual([expect.stringMatching(/^meeting:/)])
  })

  it("are only proposed on a landline: an office's number is everyone's who works there", async () => {
    const { scan, callPerson, contactPerson } = await fixture(
      [{ id: "contact/20", name: "Ana Example", phone: "+7 495 123-45-67" }],
      "+74951234567",
    )

    expect(scan.merged).toEqual([])
    expect(scan.proposed).toMatchObject([{ signal: "phone" }])
    expect(callPerson?.uid).not.toBe(contactPerson?.uid)
  })

  it("are left apart when two CRM contacts have the number", async () => {
    const { scan, callPerson, contactPerson } = await fixture(
      [
        { id: "contact/20", name: "Ana Example", phone: "+79161234567" },
        { id: "contact/21", name: "Bo Sample", phone: "+79161234567" },
      ],
      "+79161234567",
    )

    expect(scan.merged).toEqual([])
    expect(scan.proposed).toEqual([])
    expect(scan.skipped).toMatchObject([{ reason: "identity.shared-phone" }])
    expect(callPerson?.uid).not.toBe(contactPerson?.uid)
  })
})
