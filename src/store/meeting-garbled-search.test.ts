import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { sampleMeeting } from "../meetings/testing/index.js"
import { openStore } from "./store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const item of opened.splice(0)) await item.close()
})
const meetingOf = (accountId: number, texts: string[]) => {
  const input = sampleMeeting()
  input.meeting.accountId = accountId
  const original = input.transcripts[0].rows[0]
  input.transcripts[0].rows.splice(
    0,
    input.transcripts[0].rows.length,
    ...texts.map((text, i) => ({ ...original, position: i, text, speakerParticipantPosition: null })),
  )
  return input
}
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-test-garbled-")), "fixture.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path }, now: () => 1000 })
  opened.push(store)
  const accountId = await store.accounts.saveAccount(
    { provider: "example", account: "AliceExample" },
    { name: "Alice Example" },
  )
  const otherId = await store.accounts.saveAccount(
    { provider: "example", account: "BobSample" },
    { name: "Bob Sample" },
  )
  await store.meetings.saveMeeting(
    meetingOf(accountId, [
      "Итог: нужен риелтор для квартиры",
      "Позвонили реелтора вчера вечером",
      "Два рилторов пришли смотреть",
      "У дриелтора готов договор",
      "Я связался с цианом утром",
      "Объявление висит на циана",
      "Осталось десять квартир",
      "Осталось девять квартир",
      "Встреча в семь вечера",
      "Около семи человек",
      "Прошло семьдесят дней",
    ]),
  )
  await store.meetings.saveMeeting(meetingOf(otherId, ["Пришел риелтер без ключей"]))
  for (const id of [accountId, otherId]) {
    let result: { remaining: number }
    do result = await store.meetings.indexSearch({ accountId: id, limit: 50 })
    while (result.remaining)
  }
  return { store, accountId }
}

it("finds garbled spellings of a word after its exact hits, and names the stored word each matched", async () => {
  const { store, accountId } = await fixture()
  const found = await store.meetings.searchHits("риелтор", { accountId })
  expect(found.items.map((hit) => [hit.text, hit.match, hit.corrections])).toEqual([
    ["Итог: нужен риелтор для квартиры", "words", undefined],
    ["Позвонили реелтора вчера вечером", "corrected", [{ from: "риелтор", to: ["реелтора"] }]],
    ["Два рилторов пришли смотреть", "corrected", [{ from: "риелтор", to: ["рилторов"] }]],
    ["У дриелтора готов договор", "corrected", [{ from: "риелтор", to: ["дриелтора"] }]],
  ])
})

it("matches a short noun whose forms the stemmer cuts differently", async () => {
  const { store, accountId } = await fixture()
  for (const query of ["Циана", "цианом"])
    expect((await store.meetings.searchHits(query, { accountId })).items.map((hit) => hit.text).sort()).toEqual([
      "Объявление висит на циана",
      "Я связался с цианом утром",
    ])
})

it("keeps exact: words to their typed form", async () => {
  const { store, accountId } = await fixture()
  const found = await store.meetings.searchHits("exact:риелтор", { accountId })
  expect(found.items.map((hit) => hit.text)).toEqual(["Итог: нужен риелтор для квартиры"])
  expect((await store.meetings.searchHits('exact:"риелтор для"', { accountId })).items).toHaveLength(1)
})

it("never widens one number into another", async () => {
  const { store, accountId } = await fixture()
  expect((await store.meetings.searchHits("десять", { accountId })).items.map((hit) => hit.text)).toEqual([
    "Осталось десять квартир",
  ])
})

it("matches a number word in its own forms only, not in a longer number it begins", async () => {
  const { store, accountId } = await fixture()
  expect((await store.meetings.searchHits("семь", { accountId })).items.map((hit) => hit.text).sort()).toEqual([
    "Встреча в семь вечера",
    "Около семи человек",
  ])
})

it("pages through exact and widened hits without repeating or skipping one", async () => {
  const { store, accountId } = await fixture()
  const whole = (await store.meetings.searchHits("риелтор", { accountId })).items.map((hit) => hit.id)
  const paged: number[] = []
  let after: string | undefined
  do {
    const page = await store.meetings.searchHits("риелтор", { accountId, limit: 1, after })
    paged.push(...page.items.map((hit) => hit.id))
    after = page.nextCursor ?? undefined
  } while (after)
  expect(paged).toEqual(whole)
})

it("lists corrections only from the account searched", async () => {
  const { store, accountId } = await fixture()
  const found = await store.meetings.searchHits("риелтор", { accountId })
  expect(found.items.flatMap((hit) => hit.corrections ?? []).flatMap((fix) => fix.to)).not.toContain("риелтер")
})
