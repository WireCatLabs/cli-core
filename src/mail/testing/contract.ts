import assert from "node:assert/strict"
import type { ContractCase } from "../../meetings/index.js"
import type { MessageStore } from "../../store/index.js"
import { GMAIL_ALL_MAIL } from "../folders.js"
import { parseMail } from "../parse.js"
import type { MailSource } from "../source.js"
import { syncMail } from "../sync.js"
import type { FakeMail } from "./fake.js"

const SINCE = new Date("2026-09-01T00:00:00Z")

/** The fixtures every adapter is seeded with: its harness makes a mailbox that holds exactly these. */
export const CONTRACT_MAIL: FakeMail[] = [1, 2, 3].map((n) => ({
  uid: String(100 + n),
  messageId: String(9000 + n),
  threadId: String(n === 3 ? 9001 : 9000 + n),
  receivedAt: `2026-09-${String(10 + n).padStart(2, "0")}T08:00:00Z`,
  subject: `Contract subject ${n}`,
  from: ["Rin Example", "rin@example.test"],
  to: [[null, "owner@example.test"]],
  text: `Contract body ${n}`,
}))

/** An adapter over a mailbox holding `CONTRACT_MAIL`, fresh for each case. */
export type MailSourceFixture = () => MailSource | Promise<MailSource>

/** What every adapter must answer; the optional members are checked only where the source has them. */
export const mailSourceContract = (make: MailSourceFixture): ContractCase[] => {
  const test = (name: string, check: (source: MailSource) => Promise<void>): ContractCase => ({
    name,
    run: async () => check(await make()),
  })
  const folder = GMAIL_ALL_MAIL
  return [
    test("lists each message once with a stable id, a thread id and a time inside the window", async (source) => {
      const listed = await source.list(SINCE, folder)
      assert.equal(listed.length, CONTRACT_MAIL.length)
      assert.equal(new Set(listed.map(({ messageId }) => messageId)).size, listed.length)
      for (const item of listed) {
        assert.ok(item.uid && item.messageId && item.threadId, "ids")
        assert.ok(Date.parse(item.receivedAt) >= SINCE.getTime(), "inside the window")
      }
    }),
    test("lists a stable id for the same message on every listing", async (source) => {
      const ids = async () => (await source.list(SINCE, folder)).map(({ messageId }) => messageId).sort()
      assert.deepEqual(await ids(), await ids())
    }),
    test("reads the sender and recipients with `headers`", async (source) => {
      const listed = await source.list(SINCE, folder, { headers: true })
      for (const item of listed) {
        assert.equal(item.headers?.from, "rin@example.test")
        assert.deepEqual(item.headers?.to, ["owner@example.test"])
      }
    }),
    test("lists only a search's UIDs, and names the UIDVALIDITY", async (source) => {
      if (source.search === undefined) return
      const searched = await source.search(SINCE, folder)
      assert.equal(searched.uids.length, CONTRACT_MAIL.length)
      const [first] = searched.uids
      const listed = await source.list(SINCE, folder, {
        searched: { ...searched, uids: first === undefined ? [] : [first] },
      })
      assert.deepEqual(
        listed.map(({ uid }) => uid),
        first === undefined ? [] : [first],
      )
    }),
    test("returns each message's bytes in order, and one that cannot be read as an Error, not a failed call", async (source) => {
      const listed = await source.list(SINCE, folder)
      const raws = await source.fetchRaw(listed)
      assert.equal(raws.length, listed.length)
      for (const [index, raw] of raws.entries()) {
        assert.ok(raw instanceof Uint8Array, "bytes")
        const parsed = await parseMail(raw as Uint8Array, 10_000)
        assert.match(parsed.subject ?? "", /^Contract subject \d$/)
        assert.equal(
          parsed.subject,
          CONTRACT_MAIL.find(({ messageId }) => messageId === listed[index]?.messageId)?.subject,
        )
      }
      const [first] = listed
      if (first !== undefined) {
        const [unknown] = await source.fetchRaw([{ ...first, uid: "999999" }])
        assert.ok(unknown instanceof Error)
      }
    }),
    test("finds messages by id, leaving out one that is gone", async (source) => {
      if (source.find === undefined) return
      const found = await source.find(["9001", "no-such-id"], folder)
      assert.deepEqual(
        found.map(({ messageId }) => messageId),
        ["9001"],
      )
    }),
    test("says which UIDs a folder still holds", async (source) => {
      if (source.present === undefined) return
      assert.deepEqual(await source.present(["101", "999999"], folder), ["101"])
    }),
  ]
}

/** A source over `CONTRACT_MAIL` and the store it syncs into, fresh for each case. */
export type MailSyncFixture = () =>
  | { source: MailSource; store: MessageStore }
  | Promise<{ source: MailSource; store: MessageStore }>

/** What `syncMail` must do with any adapter: store each message once under the address's account, and only once. */
export const mailSyncContract = (make: MailSyncFixture): ContractCase[] => {
  const address = "owner@example.test"
  const account = { address }
  return [
    {
      name: "stores each message as an email of its thread under the address's account, and a rerun adds nothing",
      run: async () => {
        const { source, store } = await make()
        const first = await syncMail(source, store, { account, since: SINCE })
        assert.equal(first.saved, CONTRACT_MAIL.length)
        assert.equal(first.complete, true)
        const stored = await store.accounts.storedAccount({ provider: "email", account: address })
        const emails = await store.mail.emails({ accountId: stored.id })
        assert.deepEqual(
          emails.map(({ externalId }) => externalId).sort(),
          CONTRACT_MAIL.map(({ messageId }) => messageId),
        )
        const again = await syncMail(source, store, { account, since: SINCE })
        assert.equal(again.saved, 0)
        assert.equal(again.deleted, 0)
      },
    },
  ]
}
