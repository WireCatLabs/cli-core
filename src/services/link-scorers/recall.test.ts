import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import type { Chat, Message } from "../../domain/models.js"
import { type MessageStore, openStore } from "../../store/store.js"
import type { AccountKey } from "../../store/types.js"
import { scanProjectLinks } from "./scan.js"

const handles: MessageStore[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const MAX: AccountKey = { provider: "max", account: "1" }
const TG: AccountKey = { provider: "telegram", account: "2" }
const SINCE = "2026-08-10T00:00:00.000Z"

const chat = (id: string, title: string, kind: Chat["kind"] = "group"): Chat => ({
  id,
  title,
  kind,
  unreadCount: 0,
  lastMessageAt: "2026-10-20T00:00:00.000Z",
  participantsCount: null,
})

let next = 1
const messages = (chatId: string, senderId: string, count: number, text = "Synthetic note"): Message[] =>
  Array.from({ length: count }, () => {
    const id = String(next++)
    return {
      id,
      chatId,
      senderId,
      senderName: null,
      timestamp: `2026-10-15T10:${String(Math.floor(Number(id) / 60) % 60).padStart(2, "0")}:${String(Number(id) % 60).padStart(2, "0")}.000Z`,
      editedAt: null,
      text,
      outgoing: false,
      attachments: [],
      replyTo: null,
      forwardedFrom: null,
      reactions: null,
    }
  })

/**
 * Larkspur Medical (LKM), shaped like the project of the PMED run: client chats in MAX, the contractor and a 1C person
 * in Telegram dialogs, people linked across both by identity. Gold: 8 chats and 7 people. Decoys: the owner's own team
 * chat, a 40-person market group the client is in, dialogs with client people that are not the project's, a namesake
 * of the 1C person in Telegram.
 */
const fixture = async () => {
  let clock = Date.parse("2026-11-01T00:00:00.000Z")
  const store = await openStore({
    path: join(mkdtempSync(join(tmpdir(), "link-recall-")), "store.db"),
    now: () => clock++,
    decisions: { agentDecisions: true, ruleProposalsOwnerOnly: true },
  })
  handles.push(store)
  for (const key of [MAX, TG]) await store.accounts.saveAccount(key, { name: null })
  const project = await store.knowledge.addProject({ name: "Larkspur Medical", key: "LKM" })
  const other = await store.knowledge.addProject({ name: "Quill Studio", key: "QST" })

  const market = Array.from({ length: 36 }, (_, index) => String(300 + index))
  await store.people.savePeople(MAX, [
    { id: "1000", name: "Owner Example" },
    { id: "101", name: "Stan Client" },
    { id: "102", name: "Mike Content" },
    { id: "103", name: "Dmitri Papers" },
    { id: "104", name: "Yaro Partner" },
    { id: "105", name: "Alex Ledger" },
    { id: "106", name: "Val Search" },
    { id: "107", name: "Quentin Sites" },
    { id: "108", name: "Kim Staff" },
    ...market.map((id) => ({ id, name: `Market ${id}` })),
  ])
  await store.people.savePeople(TG, [
    { id: "2000", name: "Owner Example" },
    { id: "201", name: "Stan Client" },
    { id: "205", name: "Alex Ledger" },
    { id: "206", name: "Val Search" },
    { id: "208", name: "Reminder Bot" },
    { id: "209", name: "Alex Ledger" },
  ])
  await store.people.linkToOwner({ provider: "max", id: "1000" })
  await store.people.linkToOwner({ provider: "telegram", id: "2000" })
  for (const [max, tg] of [
    ["101", "201"],
    ["105", "205"],
    ["106", "206"],
  ] as const)
    await store.people.linkIdentities(
      { provider: "max", id: max },
      { provider: "telegram", id: tg },
      { method: "manual", by: "owner" },
    )

  await store.chats.saveChats(MAX, [
    chat("-10", "Larkspur Medical site"),
    chat("-20", "Client requests"),
    chat("-30", "Questor sites"),
    chat("-40", "Neirox team"),
    chat("-50", "Rental market"),
    ...["101", "102", "103", "104", "105"].map((id) => chat(`5${id}`, `dialog ${id}`, "dialog")),
  ])
  const rosters: [string, string[]][] = [
    ["-10", ["1000", "101", "102", "103", "104", "105"]],
    ["-20", ["1000", "101", "102", "106"]],
    ["-30", ["1000", "101", "102", "107"]],
    ["-40", ["1000", "104", "106", "108"]],
    ["-50", ["1000", "101", "102", ...market]],
    ...["101", "102", "103", "104", "105"].map((id): [string, string[]] => [`5${id}`, ["1000", id]]),
  ]
  for (const [id, members] of rosters) await store.roster.saveMembers(MAX, id, members)
  const said: [string, string, number][] = [
    ["-10", "101", 8],
    ["-10", "102", 6],
    ["-10", "103", 5],
    ["-10", "104", 2],
    ["-10", "105", 1],
    ["-20", "101", 3],
    ["-20", "102", 2],
    ["-20", "106", 2],
    ["-30", "101", 2],
    ["-30", "107", 3],
    ["-40", "104", 3],
    ["-40", "106", 2],
    ["-40", "108", 3],
    ["-50", "101", 1],
    ["-50", "102", 1],
    ["-50", "300", 9],
    ...["101", "102", "103", "104", "105"].map((id): [string, string, number] => [`5${id}`, id, 2]),
  ]
  for (const [id, sender, count] of said)
    await store.messages.saveMessages(MAX, id, messages(id, sender, count), { via: "history" })

  await store.chats.saveChats(TG, [
    chat("205", "Alex Ledger", "dialog"),
    chat("206", "Val Search", "dialog"),
    chat("208", "Reminder Bot", "dialog"),
    chat("209", "Alex Ledger", "dialog"),
  ])
  for (const [id, count] of [
    ["205", 2],
    ["206", 4],
    ["209", 3],
  ] as const)
    await store.messages.saveMessages(TG, id, messages(id, id, count), { via: "history" })
  await store.messages.saveMessages(TG, "208", messages("208", "208", 2, "Invoice reminder for LKM"), {
    via: "history",
  })

  const person = async (provider: string, id: string) =>
    `person:${(await store.people.personOf({ provider, id }))?.uid}`
  for (const [provider, id] of [
    ["max", "104"],
    ["max", "108"],
  ] as const)
    await store.knowledge.relate(null, {
      by: "owner",
      from: await person(provider, id),
      to: other.ref,
      kind: "member-of",
    })

  const gold = new Set([
    "chat:max/1/-10",
    "chat:max/1/5101",
    "chat:max/1/-20",
    "chat:max/1/-30",
    "chat:max/1/5105",
    "chat:telegram/2/205",
    "chat:telegram/2/206",
    "chat:telegram/2/208",
    ...(await Promise.all(["101", "102", "103", "104", "105", "106", "107"].map((id) => person("max", id)))),
  ])
  return { store, project, gold, namesake: await person("telegram", "209") }
}

/** The owner confirms what is in the gold set after each round, as the PMED run emulated it. */
const rounds = async (f: Awaited<ReturnType<typeof fixture>>, count: number) => {
  const found = new Set<string>()
  const proposed = new Set<string>()
  const recall: number[] = []
  for (let round = 0; round < count; round++) {
    const result = await scanProjectLinks(f.store, { project: "LKM", sources: [MAX, TG], since: SINCE, write: false })
    for (const { from } of result.proposals) {
      proposed.add(from)
      if (!f.gold.has(from) || found.has(from)) continue
      found.add(from)
      await f.store.knowledge.relate(null, { by: "owner", from, to: f.project.ref, kind: "member-of" })
    }
    recall.push(Math.round((found.size / f.gold.size) * 100))
  }
  const precision = Math.round((found.size / proposed.size) * 100)
  return { recall, precision, missed: [...f.gold].filter((one) => !found.has(one)), proposed }
}

it("reaches the project's Telegram dialogs and people from its MAX group within two rounds", async () => {
  const f = await fixture()
  const { recall, precision, missed, proposed } = await rounds(f, 2)
  // Before in-run spreading (origin/main b26074120): recall [7, 27], precision 100, as in the PMED run.
  expect(recall).toEqual([93, 93])
  expect(precision).toBe(74)
  expect(missed).toEqual(["chat:telegram/2/208"])
  expect(proposed.has(f.namesake)).toBe(false)
  expect(proposed.size - (f.gold.size - missed.length)).toBeLessThanOrEqual(5)
})
