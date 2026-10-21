import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { meetingWordsQuery } from "../meetings/index.js"
import { sampleMeeting } from "../meetings/testing/index.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const item of opened.splice(0)) await item.close()
})
type Line = [speaker: "alice" | "phone" | string, text: string]
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-test-query-")), "fixture.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path }, now: () => 1000 })
  opened.push(store)
  const accountId = await store.accounts.saveAccount(
    { provider: "example", account: "AliceExample" },
    { name: "Alice Example" },
  )
  const meeting = (externalId: string, lines: Line[]) => {
    const input = sampleMeeting()
    input.meeting.accountId = accountId
    input.meeting.externalId = externalId
    const alice = input.participants[0]
    input.participants.push({
      ...alice,
      identity: { ...alice.identity, externalId: "alice-phone", name: "Alice's Phone", associatePerson: false },
      displayName: "Alice's Phone",
      externalId: "alice-phone",
    })
    const row = input.transcripts[0].rows[0]
    input.transcripts[0].rows.splice(
      0,
      input.transcripts[0].rows.length,
      ...lines.map(([speaker, text], position) => ({
        ...row,
        position,
        text,
        speakerParticipantPosition: speaker === "alice" ? 0 : speaker === "phone" ? 1 : null,
        speakerName: speaker === "alice" ? "Alice Example" : speaker === "phone" ? "Alice's Phone" : speaker,
      })),
    )
    return input
  }
  await store.meetings.saveMeeting(
    meeting("first", [
      ["alice", "Нужен риелтор на завтра"],
      ["Bob Sample", "Ипотека одобрена банком"],
      ["Bob Other", "Риелтор и ипотека вместе"],
      ["phone", "Договор подпишем в пятницу"],
      ["Bob Sample", "Перезвоню позже"],
    ]),
  )
  const db = await openCache(path)
  opened.push(db)
  const id = (externalId: string) =>
    Number(db.prepare("SELECT id FROM identities WHERE external_id=?").get(externalId)?.id)
  const person = Number(
    db.prepare("SELECT person_id FROM identity_links WHERE identity_id=?").get(id("alice-example"))?.person_id,
  )
  db.prepare(
    "INSERT INTO identity_links(identity_id,person_id,method,confidence,created_at,author,updated_at) VALUES(?,?,'manual',1,1000,'owner',1000)",
  ).run(id("alice-phone"), person)
  let result: { remaining: number }
  do result = await store.meetings.indexSearch({ accountId, limit: 50 })
  while (result.remaining)
  const texts = async (query: Parameters<typeof store.meetings.searchHits>[0]) =>
    (await store.meetings.searchHits(query, { accountId })).items
      .filter((hit) => hit.scope === "transcript")
      .map((hit) => hit.text)
      .sort()
  return { store, accountId, texts }
}

it("requires every bare word, as before", async () => {
  const { texts } = await fixture()
  expect(await texts("риелтор ипотека")).toEqual(["Риелтор и ипотека вместе"])
})

it("finds either side of OR", async () => {
  const { texts } = await fixture()
  expect(await texts("риелтор OR договор")).toEqual([
    "Договор подпишем в пятницу",
    "Нужен риелтор на завтра",
    "Риелтор и ипотека вместе",
  ])
})

it("groups with parentheses", async () => {
  const { texts } = await fixture()
  expect(await texts("(риелтор OR ипотека) вместе")).toEqual(["Риелтор и ипотека вместе"])
})

it("excludes a word with NOT and with a minus", async () => {
  const { texts } = await fixture()
  expect(await texts("риелтор NOT ипотека")).toEqual(["Нужен риелтор на завтра"])
  expect(await texts("ипотека -риелтор")).toEqual(["Ипотека одобрена банком"])
})

it("matches a nothing-but-exclusions query to nothing", async () => {
  const { texts } = await fixture()
  expect(await texts("-риелтор")).toEqual([])
})

it("finds a phrase only as neighbouring words, in any form", async () => {
  const { texts } = await fixture()
  expect(await texts('"ипотеку одобрили"')).toEqual(["Ипотека одобрена банком"])
  expect(await texts('"одобрена ипотека"')).toEqual([])
  expect(await texts('exact:"ипотека одобрена"')).toEqual(["Ипотека одобрена банком"])
  expect(await texts('exact:"ипотеку одобрили"')).toEqual([])
})

it("finds the lines a person said, on every device linked to them", async () => {
  const { texts } = await fixture()
  expect(await texts('from:"Alice Example"')).toEqual(["Договор подпишем в пятницу", "Нужен риелтор на завтра"])
  expect(await texts("from:alice риелтор")).toEqual(["Нужен риелтор на завтра"])
  expect(await texts('from:"Bob Sample"')).toEqual(["Ипотека одобрена банком", "Перезвоню позже"])
})

it("refuses a speaker it cannot pick, and names the candidates", async () => {
  const { store, accountId } = await fixture()
  await expect(store.meetings.searchHits("from:Bob", { accountId })).rejects.toMatchObject({
    code: "validation_error",
    details: { candidates: [{ name: "Bob Other" }, { name: "Bob Sample" }] },
  })
  await expect(store.meetings.searchHits("from:Carol", { accountId })).rejects.toMatchObject({ code: "not_found" })
})

it("refuses operators meetings do not support", async () => {
  const { store, accountId } = await fixture()
  for (const query of ["риел*", "text:/риел.*/", "subject:риелтор"])
    await expect(store.meetings.searchHits(query, { accountId })).rejects.toMatchObject({ code: "validation_error" })
})

it("takes words that must not become syntax as plain words", async () => {
  const { texts } = await fixture()
  expect(await texts(meetingWordsQuery("Риелтор: (ипотека)"))).toEqual(["Риелтор и ипотека вместе"])
})

it("pages an OR whose sides rank differently without repeating or skipping a hit", async () => {
  const { store, accountId } = await fixture()
  const query = "exact:риелтор OR ипотеке"
  const whole = (await store.meetings.searchHits(query, { accountId })).items.map((hit) => hit.id)
  const paged: number[] = []
  let after: string | undefined
  do {
    const page = await store.meetings.searchHits(query, { accountId, limit: 1, after })
    paged.push(...page.items.map((hit) => hit.id))
    after = page.nextCursor ?? undefined
  } while (after)
  expect(paged).toEqual(whole)
  expect(whole.length).toBeGreaterThan(2)
})

it('finds words spread over neighbouring lines with "a b"~N, from a line that holds one of them', async () => {
  const { texts } = await fixture()
  expect(await texts('"риелтор договор"~3')).toEqual([
    "Договор подпишем в пятницу",
    "Нужен риелтор на завтра",
    "Риелтор и ипотека вместе",
  ])
  expect(await texts('"риелтор договор"~1')).toEqual(["Договор подпишем в пятницу", "Риелтор и ипотека вместе"])
  expect(await texts('"риелтор ипотека"~0')).toEqual(["Риелтор и ипотека вместе"])
  expect(await texts('"риелтор перезвоню"~1')).toEqual([])
})

it("refuses a distance beyond 20 lines and a fuzzy word", async () => {
  const { store, accountId } = await fixture()
  for (const query of ['"риелтор договор"~21', "риелтор~2"])
    await expect(store.meetings.searchHits(query, { accountId })).rejects.toMatchObject({ code: "validation_error" })
})
