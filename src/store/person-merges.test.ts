import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseLucene } from "@wirecat/cli-base/query"
import { afterEach, describe, expect, it } from "vitest"
import { openCache } from "./open.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const CRM: AccountKey = { provider: "bitrix24", account: "acme.example" }
const TG: AccountKey = { provider: "telegram", account: "1" }
const owner = { method: "manual", by: "owner" }
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

let path = ""
const open = async () => {
  path = join(mkdtempSync(join(tmpdir(), "person-merges-")), "store.db")
  const store = await openStore({ path })
  opened.push(store)
  return store
}

const uidOf = async (store: MessageStore, provider: string, id: string) =>
  (await store.people.personOf({ provider, id }))?.uid as string

const saveCrmAlice = (store: MessageStore) =>
  store.people.savePeople(CRM, [{ id: "contact/20", name: "Alice Example", email: "alice@acme.example" }])

const chain = async (store: MessageStore) => {
  await store.people.savePeople(TG, [
    { id: "1", name: "Ana" },
    { id: "2", name: "Bea" },
    { id: "3", name: "Cas" },
  ])
  const [a, b, c] = [
    await uidOf(store, "telegram", "1"),
    await uidOf(store, "telegram", "2"),
    await uidOf(store, "telegram", "3"),
  ]
  const link = (one: string, other: string) =>
    store.people.linkIdentities({ provider: "telegram", id: one }, { provider: "telegram", id: other }, owner)
  await link("2", "1")
  await link("3", "2")
  return { a, b, c }
}

const identitiesOf = async (store: MessageStore, uid: string) =>
  (await store.people.personByUid(uid))?.identities.map(({ provider, id }) => `${provider}:${id}`)

describe("a merge", () => {
  it("is listed with the identities that came in, and undoing it gives the old uid its identities back", async () => {
    const store = await open()
    await store.people.savePeople(CRM, [{ id: "contact/20", name: "Alice Example" }])
    const crm = await uidOf(store, "bitrix24", "contact/20")
    await saveCrmAlice(store)
    const mail = await uidOf(store, "email", "alice@acme.example")

    const [merge] = await store.people.merges(mail)
    expect(merge).toMatchObject({
      id: `merge:${mail}-${crm}`,
      from: crm,
      to: mail,
      identities: [{ provider: "bitrix24", id: "contact/20", name: "Alice Example" }],
      method: "same-email",
      by: "bitrix24",
    })

    const restored = await store.people.undoMerge(mail, crm, "owner")

    expect(restored.uid).toBe(crm)
    expect(await identitiesOf(store, crm)).toEqual(["bitrix24:contact/20"])
    expect(await identitiesOf(store, mail)).toEqual(["email:alice@acme.example"])
    expect(await store.people.merges(mail)).toEqual([])
  })

  it("stays undone when the same address comes in again", async () => {
    const store = await open()
    await store.people.savePeople(CRM, [{ id: "contact/20", name: "Alice Example" }])
    const crm = await uidOf(store, "bitrix24", "contact/20")
    await saveCrmAlice(store)
    const mail = await uidOf(store, "email", "alice@acme.example")
    await store.people.undoMerge(mail, crm, "owner")

    await saveCrmAlice(store)

    expect(await uidOf(store, "bitrix24", "contact/20")).toBe(crm)
    expect(await uidOf(store, "email", "alice@acme.example")).toBe(mail)
  })

  it("can be undone again after the owner merges the same people once more", async () => {
    const store = await open()
    await store.people.savePeople(CRM, [{ id: "contact/20", name: "Alice Example" }])
    const crm = await uidOf(store, "bitrix24", "contact/20")
    await saveCrmAlice(store)
    const mail = await uidOf(store, "email", "alice@acme.example")
    await store.people.undoMerge(mail, crm, "owner")
    await store.people.linkIdentities(
      { provider: "email", id: "alice@acme.example" },
      { provider: "bitrix24", id: "contact/20" },
      owner,
    )

    await store.people.undoMerge(mail, crm, "owner")

    expect(await identitiesOf(store, crm)).toEqual(["bitrix24:contact/20"])
  })

  it("has nothing left to undo once the owner unlinked all of it", async () => {
    const store = await open()
    await store.people.savePeople(CRM, [{ id: "contact/20", name: "Alice Example" }])
    const crm = await uidOf(store, "bitrix24", "contact/20")
    await saveCrmAlice(store)
    const mail = await uidOf(store, "email", "alice@acme.example")
    await store.people.unlinkIdentity({ provider: "bitrix24", id: "contact/20" }, owner)

    await expect(store.people.undoMerge(mail, crm, "owner")).rejects.toMatchObject({ code: "not_found" })
    expect(await store.people.merges(mail)).toEqual([])
  })

  it("is never an unlink made before unlinks had their own method", async () => {
    const store = await open()
    await store.people.savePeople(TG, [
      { id: "201", name: "Alice" },
      { id: "202", name: "Alice Work" },
    ])
    await store.people.linkIdentities({ provider: "telegram", id: "201" }, { provider: "telegram", id: "202" }, owner)
    const alice = await uidOf(store, "telegram", "201")
    const alone = (await store.people.unlinkIdentity({ provider: "telegram", id: "202" }, owner)).uid
    const database = await openCache(path)
    try {
      database.prepare("UPDATE identity_link_events SET method = 'manual' WHERE method = 'unlink'").run()
    } finally {
      database.close()
    }

    expect(await store.people.merges(alone)).toEqual([])
    await expect(store.people.undoMerge(alone, alice, "owner")).rejects.toMatchObject({ code: "not_found" })
  })

  it("in a chain is undone newest first", async () => {
    const store = await open()
    const { a, b, c } = await chain(store)

    await store.people.undoMerge(c, b, "owner")
    expect((await store.people.merges(b)).map(({ id }) => id)).toEqual([`merge:${b}-${a}`])
    await store.people.undoMerge(b, a, "owner")

    expect(await identitiesOf(store, a)).toEqual(["telegram:1"])
    expect(await identitiesOf(store, b)).toEqual(["telegram:2"])
    expect(await identitiesOf(store, c)).toEqual(["telegram:3"])
  })

  it("is not undone after its person was merged on into a third", async () => {
    const store = await open()
    const { a, b } = await chain(store)

    await expect(store.people.undoMerge(b, a, "owner")).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "identity.stale" },
    })
  })

  it("into the owner is a merge, with every identity of the person", async () => {
    const store = await open()
    await store.people.savePeople(TG, [
      { id: "5", name: "Slava" },
      { id: "6", name: "Slava Work" },
    ])
    await store.people.linkIdentities({ provider: "telegram", id: "5" }, { provider: "telegram", id: "6" }, owner)
    const mine = await uidOf(store, "telegram", "5")
    const me = (await store.people.linkToOwner({ provider: "telegram", id: "5" })).uid

    expect(await store.people.personByUid(mine)).toMatchObject({ uid: me, mergedInto: me })
    const [merge] = await store.people.merges(me)
    expect(merge?.from).toBe(mine)
    expect(merge?.identities.map(({ id }) => id).sort()).toEqual(["5", "6"])
  })

  it("undoes what is still on the person when the owner split some of it off since", async () => {
    const store = await open()
    await store.people.savePeople(TG, [
      { id: "1", name: "Ana" },
      { id: "2", name: "Ana Work" },
      { id: "3", name: "Ana Old" },
      { id: "4", name: "Bea" },
    ])
    const link = (one: string, other: string) =>
      store.people.linkIdentities({ provider: "telegram", id: one }, { provider: "telegram", id: other }, owner)
    await link("1", "2")
    await link("1", "3")
    const ana = await uidOf(store, "telegram", "1")
    const bea = await uidOf(store, "telegram", "4")
    await link("4", "1")
    await store.people.split(bea, [{ provider: "telegram", id: "3" }], "owner")

    expect((await store.people.merges(bea))[0]?.identities.map(({ id }) => id)).toEqual(["1", "2"])
    await store.people.undoMerge(bea, ana, "owner")

    expect(await identitiesOf(store, ana)).toEqual(["telegram:1", "telegram:2"])
    expect(await identitiesOf(store, bea)).toEqual(["telegram:4"])
  })

  it("is undone only by the owner", async () => {
    const store = await open()
    await store.people.savePeople(CRM, [{ id: "contact/20", name: "Alice Example" }])
    const crm = await uidOf(store, "bitrix24", "contact/20")
    await saveCrmAlice(store)
    const mail = await uidOf(store, "email", "alice@acme.example")

    await expect(store.people.undoMerge(mail, crm, "agent")).rejects.toMatchObject({
      code: "permission_error",
      details: { reason: "identity.owner-only" },
    })
    await expect(store.people.undoMerge(crm, mail, "owner")).rejects.toMatchObject({ code: "not_found" })
  })
})

describe("a split", () => {
  it("moves the chosen identities to one new person, and the same address does not join them again", async () => {
    const store = await open()
    await saveCrmAlice(store)
    const alice = await uidOf(store, "email", "alice@acme.example")

    const apart = await store.people.split(alice, [{ provider: "bitrix24", id: "contact/20" }], "owner")
    await saveCrmAlice(store)

    expect(apart.uid).not.toBe(alice)
    expect(await identitiesOf(store, apart.uid)).toEqual(["bitrix24:contact/20"])
    expect(await identitiesOf(store, alice)).toEqual(["email:alice@acme.example"])
    expect(await store.people.merges(apart.uid)).toEqual([])
  })

  it("is refused for an agent, for no identity, for all of them and for someone else's", async () => {
    const store = await open()
    await saveCrmAlice(store)
    await store.people.savePeople(TG, [{ id: "201", name: "Alice" }])
    const alice = await uidOf(store, "email", "alice@acme.example")
    const crm = { provider: "bitrix24", id: "contact/20" }

    await expect(store.people.split(alice, [crm], "agent")).rejects.toMatchObject({ code: "permission_error" })
    await expect(store.people.split(alice, [], "owner")).rejects.toMatchObject({ code: "validation_error" })
    await expect(
      store.people.split(alice, [crm, { provider: "email", id: "alice@acme.example" }], "owner"),
    ).rejects.toMatchObject({ code: "validation_error" })
    await expect(store.people.split(alice, [{ provider: "telegram", id: "201" }], "owner")).rejects.toMatchObject({
      code: "validation_error",
    })
  })
})

describe("a merged-away person", () => {
  const linkedAlice = async (store: MessageStore) => {
    await store.people.savePeople(TG, [{ id: "201", name: "Alice" }])
    await store.people.savePeople(CRM, [{ id: "contact/20", name: "Alice Example" }])
    const before = {
      telegram: await uidOf(store, "telegram", "201"),
      crm: await uidOf(store, "bitrix24", "contact/20"),
    }
    await saveCrmAlice(store)
    await store.people.linkIdentities(
      { provider: "bitrix24", id: "contact/20" },
      { provider: "telegram", id: "201" },
      owner,
    )
    return { ...before, alice: await uidOf(store, "telegram", "201") }
  }

  it("is left out of the people list, so a CRM contact and a Telegram identity the owner linked are one Alice", async () => {
    const store = await open()
    const { telegram, crm, alice } = await linkedAlice(store)
    const byName = await store.people.add({ name: "Alice Byname" })

    const listed = (await store.tasks.taskPeople()).filter(({ owner }) => !owner).map(({ person }) => person)

    expect(listed).toContain(`person:${alice}`)
    expect(listed).toContain(`person:${byName.uid}`)
    expect(listed).not.toContain(`person:${telegram}`)
    expect(listed).not.toContain(`person:${crm}`)
    expect(listed).toHaveLength(2)
  })

  it("is the person its identities moved to when an old reference names it", async () => {
    const store = await open()
    const { telegram, crm, alice } = await linkedAlice(store)
    const tg = await store.accounts.storedAccount(TG)

    for (const old of [telegram, crm]) {
      expect(await store.people.personByUid(old)).toMatchObject({ uid: alice, mergedInto: alice })
      expect(await store.people.personSeenInAccounts(old, [tg.id])).toBe(true)
    }
    expect((await store.people.personByUid(alice))?.mergedInto).toBeUndefined()
  })

  it("keeps what names it as written, and the person it became reads it with their own", async () => {
    const store = await open()
    const { telegram, alice } = await linkedAlice(store)
    const note = await store.notes.addNote({ text: "Alice prefers mornings", about: [`person:${telegram}`] })
    const memory = await store.memories.add({
      kind: "preference",
      body: "Alice prefers morning calls",
      scope: "work",
      evidence: [note.ref],
      subject: `person:${telegram}`,
      author: { bot: "digest-writer", model: "synthetic-model-1" },
    })
    const fact = await store.facts.add({
      type: "fact",
      statement: "Prefers written examples",
      subject: `person:${telegram}`,
      by: "owner",
    })
    await store.knowledge.addProject({ name: "Harbour launch", key: "HRB", type: "work" })
    const task = await store.tasks.create({ project: "HRB", title: "Call Alice", type: "chore" }, "owner")
    await store.tasks.assign(task.id, { to: `person:${telegram}`, role: "assignee" }, "owner")
    const current = `person:${alice}`

    expect(memory.subject).toBe(`person:${telegram}`)
    expect((await store.memories.list({ subject: current })).map(({ ref }) => ref)).toEqual([memory.ref])
    expect((await store.facts.list({ subject: current })).map(({ ref }) => ref)).toEqual([fact.ref])
    expect((await store.notes.notes({ about: current })).items.map(({ ref }) => ref)).toContain(note.ref)
    const board = await store.tasks.board(parseLucene(`assignee:"${current}"`, { defaultField: "text" }), { limit: 5 })
    expect(board.items.map(({ key }) => key)).toEqual(["HRB-1"])
    expect((await store.tasks.taskPeople()).find(({ person }) => person === current)?.tasks).toBe(1)
  })

  it("is assigned once: the person it became already holds its task", async () => {
    const store = await open()
    const { telegram, alice } = await linkedAlice(store)
    await store.knowledge.addProject({ name: "Harbour launch", key: "HRB", type: "work" })
    const task = await store.tasks.create({ project: "HRB", title: "Call Alice", type: "chore" }, "owner")
    await store.tasks.assign(task.id, { to: `person:${alice}`, role: "assignee" }, "owner")

    await store.tasks.assign(task.id, { to: `person:${telegram}`, role: "assignee" }, "owner")

    expect((await store.tasks.taskPeople()).find(({ person }) => person === `person:${alice}`)?.tasks).toBe(1)
    const database = await openCache(path)
    try {
      expect(database.prepare("SELECT count(*) AS n FROM task_assignments").get()?.n).toBe(1)
    } finally {
      database.close()
    }
  })

  it("keeps its linked documents under the person it became", async () => {
    const store = await open()
    const { telegram, alice } = await linkedAlice(store)
    const folder = (await store.notes.addFolder({ name: "Synthetic drive" })).id
    const { note } = await store.notes.saveFileNote({ folderId: folder, path: "a.md", title: "a.md", text: "a body" })
    await store.notes.addLink({ by: "owner", from: note.ref, to: `person:${telegram}`, kind: "about" })

    const found = await store.notes.importedDocuments(
      folder,
      parseLucene(`person:${alice}`, { defaultField: "none" }),
      { limit: 5, offset: 0 },
    )

    expect(found.items.map(({ path }) => path)).toEqual(["a.md"])
  })

  it("shows a source's relationship once when the source reports it again on the person it became", async () => {
    const store = await open()
    await store.people.savePeople(TG, [{ id: "201", name: "Alice" }])
    await store.people.savePeople(CRM, [{ id: "contact/20", name: "Alice Example" }])
    const crm = `person:${await uidOf(store, "bitrix24", "contact/20")}`
    const acme = (await store.knowledge.addOrganization({ kind: "company", name: "Acme Ltd" })).ref
    const contact = (from: string) => [{ from, to: acme, kind: "member-of" as const, role: "contact" }]
    const scope = (from: string) => ({ from: [from], kinds: ["member-of" as const], roles: ["contact"] })
    await store.relations.syncReported(CRM, contact(crm), scope(crm))
    await store.people.linkIdentities(
      { provider: "telegram", id: "201" },
      { provider: "bitrix24", id: "contact/20" },
      owner,
    )
    const alice = `person:${await uidOf(store, "telegram", "201")}`

    await store.relations.syncReported(CRM, contact(alice), scope(alice))

    const live = (await store.knowledge.relations(null, alice)).filter(({ standing }) => standing !== "ended")
    expect(live.map(({ from, to }) => [from, to])).toEqual([[alice, acme]])
  })

  it("leaves what named it before the merge in the preparation of the person it became", async () => {
    const store = await open()
    await store.people.savePeople(TG, [{ id: "201", name: "Alice" }])
    await store.people.savePeople(CRM, [{ id: "contact/20", name: "Alice Example" }])
    const crm = await uidOf(store, "bitrix24", "contact/20")
    await store.facts.add({
      type: "fact",
      statement: "Prefers written examples",
      subject: `person:${crm}`,
      by: "owner",
    })
    await store.notes.addNote({ text: "Asked about the invoice", about: [`person:${crm}`] })
    await store.people.linkIdentities(
      { provider: "telegram", id: "201" },
      { provider: "bitrix24", id: "contact/20" },
      owner,
    )
    const alice = await uidOf(store, "telegram", "201")

    const read = await store.people.preparation(alice, { accounts: [TG, CRM], limit: 10 })

    expect(alice).not.toBe(crm)
    expect(read.facts.items.map(({ statement }) => statement)).toEqual(["Prefers written examples"])
    expect(read.notes.items.map(({ text }) => text)).toEqual(["Asked about the invoice"])
  })

  it("is in the links list of the person it became, both ways", async () => {
    const store = await open()
    const { telegram, alice } = await linkedAlice(store)
    const note = await store.notes.addNote({ text: "Met at the harbour" })
    await store.notes.addLink({ by: "owner", from: note.ref, to: `person:${telegram}`, kind: "about" })
    const acme = (await store.knowledge.addOrganization({ kind: "company", name: "Acme Ltd" })).ref
    await store.knowledge.relate(null, { by: "owner", from: `person:${telegram}`, to: acme, kind: "member-of" })

    const into = await store.notes.links({ to: `person:${alice}` })
    const out = await store.notes.links({ from: `person:${alice}` })

    expect(into.map(({ from, kind }) => [from, kind])).toEqual([[note.ref, "about"]])
    expect(out.map(({ to, kind }) => [to, kind])).toEqual([[acme, "member-of"]])
  })

  it("keeps the direction of its relationships in the list of the person it became", async () => {
    const store = await open()
    const { telegram, alice } = await linkedAlice(store)
    const acme = (await store.knowledge.addOrganization({ kind: "company", name: "Acme Ltd" })).ref
    const bob = (await store.people.add({ name: "Bob Example" })).uid
    await store.knowledge.relate(null, { by: "owner", from: `person:${telegram}`, to: acme, kind: "member-of" })
    await store.knowledge.relate(null, {
      by: "owner",
      from: `person:${bob}`,
      to: `person:${telegram}`,
      kind: "reports-to",
    })

    const listed = await store.knowledge.listRelations({ about: `person:${alice}` })

    expect(listed.items.map(({ kind, direction }) => [kind, direction])).toEqual([
      ["member-of", "outgoing"],
      ["reports-to", "incoming"],
    ])
    expect((await store.knowledge.listRelations({ from: `person:${alice}` })).items.map(({ kind }) => kind)).toEqual([
      "member-of",
    ])
  })

  it("is kept by a purge while anything still points at it, and goes with the account when nothing does", async () => {
    const store = await open()
    await store.people.savePeople(TG, [
      { id: "201", name: "Alice" },
      { id: "202", name: "Alice Work" },
      { id: "301", name: "Bob" },
      { id: "302", name: "Bob Work" },
    ])
    const tagged = await uidOf(store, "telegram", "202")
    const untagged = await uidOf(store, "telegram", "302")
    await store.people.linkIdentities({ provider: "telegram", id: "201" }, { provider: "telegram", id: "202" }, owner)
    await store.people.linkIdentities({ provider: "telegram", id: "301" }, { provider: "telegram", id: "302" }, owner)
    await store.knowledge.addTags(null, { type: "person", id: tagged }, ["client"])

    await store.accounts.purge(TG)

    expect(await store.people.personByUid(tagged)).toMatchObject({ mergedInto: expect.any(String) })
    expect((await store.tasks.taskPeople()).map(({ person }) => person)).not.toContain(`person:${tagged}`)
    expect(await store.people.personByUid(untagged)).toBeUndefined()
  })
})
