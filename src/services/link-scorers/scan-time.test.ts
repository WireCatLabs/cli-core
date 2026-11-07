import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import type { Chat, Message } from "../../domain/models.js"
import { openStore } from "../../store/store.js"
import type { AccountKey } from "../../store/types.js"
import { scanProjectLinks } from "./scan.js"

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
const messages = (chatId: string, senders: string[], count: number): Message[] =>
  Array.from({ length: count }, (_, index) => {
    const id = String(next++)
    return {
      id,
      chatId,
      senderId: senders[index % senders.length] ?? "1000",
      senderName: null,
      timestamp: new Date(Date.parse("2026-09-01T00:00:00.000Z") + Number(id) * 1000).toISOString(),
      editedAt: null,
      text: `Synthetic note ${id}`,
      outgoing: false,
      attachments: [],
      replyTo: null,
      forwardedFrom: null,
      reactions: null,
    }
  })

// Takes a minute to build; run by hand with LINK_SCAN_TIME=1 (LINK_SEEDED=1 confirms the named group and its 8 people).
it.runIf(process.env.LINK_SCAN_TIME)("scan time on 2 000 chats with spreading", { timeout: 600_000 }, async () => {
  const store = await openStore({
    path: join(mkdtempSync(join(tmpdir(), "scan-time-")), "store.db"),
    decisions: { agentDecisions: true, ruleProposalsOwnerOnly: true },
  })
  for (const key of [MAX, TG]) await store.accounts.saveAccount(key, { name: null })
  const project = await store.knowledge.addProject({ name: "Larkspur Medical", key: "LKM" })
  const people = Array.from({ length: 400 }, (_, index) => String(100 + index))
  await store.people.savePeople(MAX, [{ id: "1000", name: "Owner" }, ...people.map((id) => ({ id, name: `P ${id}` }))])
  await store.people.savePeople(TG, [{ id: "2000", name: "Owner" }, ...people.map((id) => ({ id, name: `P ${id}` }))])
  await store.people.linkToOwner({ provider: "max", id: "1000" })
  await store.people.linkToOwner({ provider: "telegram", id: "2000" })
  for (const id of people.slice(0, 40))
    await store.people.linkIdentities(
      { provider: "max", id },
      { provider: "telegram", id },
      { method: "manual", by: "owner" },
    )
  const project8 = people.slice(0, 8)
  const groups: Chat[] = [chat("-1", "Larkspur Medical site")]
  for (let index = 0; index < 1000; index++) groups.push(chat(String(-100 - index), `Group ${index}`))
  const dialogs = people.map((id) => chat(`5${id}`, `dialog ${id}`, "dialog"))
  await store.chats.saveChats(MAX, [...groups, ...dialogs])
  await store.chats.saveChats(
    TG,
    Array.from({ length: 600 }, (_, index) => chat(String(-5000 - index), `TG group ${index}`)).concat(
      people.slice(0, 40).map((id) => chat(id, `tg ${id}`, "dialog")),
    ),
  )
  await store.roster.saveMembers(MAX, "-1", ["1000", ...project8])
  await store.messages.saveMessages(MAX, "-1", messages("-1", project8, 400), { via: "history" })
  for (let index = 0; index < 1000; index++) {
    const id = String(-100 - index)
    const members = Array.from({ length: index % 3 === 0 ? 6 : 40 }, (_, k) => people[(index * 7 + k) % 400] as string)
    await store.roster.saveMembers(MAX, id, ["1000", ...members])
    await store.messages.saveMessages(MAX, id, messages(id, members, 60), { via: "history" })
  }
  for (const id of people) await store.roster.saveMembers(MAX, `5${id}`, ["1000", id])
  for (const id of people.slice(0, 100))
    await store.messages.saveMessages(MAX, `5${id}`, messages(`5${id}`, [id], 30), { via: "history" })
  for (let index = 0; index < 600; index++) {
    const id = String(-5000 - index)
    const members = Array.from({ length: 8 }, (_, k) => people[(index * 5 + k) % 40] as string)
    await store.roster.saveMembers(TG, id, ["2000", ...members])
    await store.messages.saveMessages(TG, id, messages(id, members, 40), { via: "history" })
  }
  if (process.env.LINK_SEEDED)
    for (const from of [
      "chat:max/1/-1",
      ...(await Promise.all(
        project8.map(async (id) => `person:${(await store.people.personOf({ provider: "max", id }))?.uid}`),
      )),
    ])
      await store.knowledge.relate(null, { by: "owner", from, to: project.ref, kind: "member-of" })
  const started = performance.now()
  const result = await scanProjectLinks(store, { project: "LKM", sources: [MAX, TG], since: SINCE, write: false })
  const elapsed = Math.round(performance.now() - started)
  process.stdout.write(`SCANTIME ${elapsed} ms, ${result.proposals.length} proposals\n`)
  await store.close()
  expect(elapsed).toBeLessThan(5000)
})
