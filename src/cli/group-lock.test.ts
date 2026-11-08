import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import * as v from "valibot"
import { afterEach, describe, expect, it } from "vitest"
import { syncCrm } from "../crm/index.js"
import { exampleDeal, exampleOrganization, examplePerson, fakeCrmSource } from "../crm/testing/index.js"
import { type GroupGuard, groupGuardOf, lockedRegistry } from "../services/group-guard.js"
import type { ProposalRegistry, ProposalRow } from "../services/proposals/types.js"
import { openCache } from "../store/open.js"
import { storePath } from "../store/path.js"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
import { groupAware, refKinds, refuseOutsideGroup } from "./group-lock.js"
import { run } from "./program.js"

const app = { command: "memo", appName: "group-lock-test", envPrefix: "MEMO", description: "", version: "0" }
const tgPersonal: AccountKey = { provider: "telegram", account: "101" }
const tgWork: AccountKey = { provider: "telegram", account: "102" }
const crmWork: AccountKey = { provider: "example-crm", account: "work-portal" }
const crmOther: AccountKey = { provider: "example-crm", account: "other-portal" }

const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})

const envOf = (group = "work") => ({
  ...process.env,
  WIRECAT_STATE_DIR: mkdtempSync(join(tmpdir(), "group-lock-")),
  MEMO_GROUP_LOCK: group,
})

/** `work` holds the work Telegram account and one CRM; the other CRM and the personal Telegram are outside it. */
const seeded = async (env: NodeJS.ProcessEnv) => {
  const store = await openStore({ env })
  live.push(store)
  for (const key of [tgPersonal, tgWork, crmWork, crmOther]) await store.accounts.saveAccount(key, { name: null })
  await store.accounts.saveAccountGroup("work", ["telegram:102", "example-crm:work-portal"])
  for (const [key, id] of [
    [crmWork, "w"],
    [crmOther, "o"],
  ] as const) {
    const source = fakeCrmSource()
    source.put("deal", exampleDeal(`deal-${id}`))
    source.put("organization", exampleOrganization(`org-${id}`))
    source.put("person", examplePerson(`person-${id}`))
    await syncCrm(source, store, key)
  }
  return store
}

const rowOf = async (env: NodeJS.ProcessEnv, sql: string, ...params: unknown[]) => {
  const database = await openCache(storePath(env))
  try {
    return Number((database.prepare(sql).get(...(params as never[])) as { id: number }).id)
  } finally {
    database.close()
  }
}

const organizationOf = (env: NodeJS.ProcessEnv, account: AccountKey) =>
  rowOf(
    env,
    "SELECT r.entity_id AS id FROM records r JOIN accounts a ON a.id = r.account_id " +
      "WHERE r.entity_type = 'organization' AND a.external_id = ?",
    account.account,
  )

const personOf = (env: NodeJS.ProcessEnv, account: AccountKey) =>
  rowOf(
    env,
    "SELECT l.person_id AS id FROM identity_links l JOIN account_identities ai ON ai.identity_id = l.identity_id " +
      "JOIN accounts a ON a.id = ai.account_id WHERE a.external_id = ?",
    account.account,
  )

/** Group-aware commands shaped as memo's are, parsed. */
const parsed = (argv: string[]) => {
  const program = new Command().exitOverride()
  const noop = () => undefined
  const tags = groupAware(new Command("tags"))
  refKinds(tags.command("add").argument("<tag>").option("--message <ref>").option("--note <id>"), {}).action(noop)
  const deals = groupAware(new Command("deals"))
  deals.command("update").argument("<deal>").option("--project <ref>").action(noop)
  const organizations = groupAware(new Command("organizations"))
  organizations.command("show").argument("<ref>").action(noop)
  refKinds(organizations.command("rename").argument("<organization>").argument("<name>"), {}).action(noop)
  refKinds(organizations.command("open").argument("<id>"), { id: "organization" }).action(noop)
  const actions = groupAware(new Command("actions"))
  refKinds(actions.command("confirm").argument("<id>"), { id: "action" }).action(noop)
  const review = groupAware(new Command("review"))
  refKinds(review.command("confirm").argument("<ids...>"), { ids: "proposal" }).action(noop)
  const events = groupAware(new Command("events"))
  events.command("show").argument("<event>").action(noop)
  program
    .addCommand(tags)
    .addCommand(deals)
    .addCommand(organizations)
    .addCommand(events)
    .addCommand(actions)
    .addCommand(review)
  program.command("show").argument("<ref>").action(noop)
  program.addCommand(groupAware(refKinds(new Command("search").argument("<words>").action(noop), {})))
  let leaf: Command | undefined
  program.hook("preAction", (_root, action) => {
    leaf = action
  })
  program.parse(argv, { from: "user" })
  return leaf as Command
}

const refused = (env: NodeJS.ProcessEnv, store: MessageStore, argv: string[]) =>
  expect(refuseOutsideGroup(parsed(argv), { app, env, store })).rejects.toThrow(
    expect.objectContaining({ code: "permission_error" }),
  )
const allowed = (env: NodeJS.ProcessEnv, store: MessageStore, argv: string[]) =>
  expect(refuseOutsideGroup(parsed(argv), { app, env, store })).resolves.toBeUndefined()

describe("the group lock fails closed", () => {
  it("checks a bare id by the kind its argument or option names, and refuses one of an unknown kind", async () => {
    const env = envOf()
    const store = await seeded(env)
    const other = await organizationOf(env, crmOther)
    const own = await organizationOf(env, crmWork)
    await refused(env, store, ["organizations", "rename", String(other), "Pwned"])
    await allowed(env, store, ["organizations", "rename", String(own), "Renamed"])
    await refused(env, store, ["organizations", "open", String(other)])
    await allowed(env, store, ["organizations", "open", String(own)])
    await expect(
      refuseOutsideGroup(parsed(["organizations", "show", String(own)]), { app, env, store }),
    ).rejects.toThrow(new RegExp(`takes <ref> ${own} as an id of a kind it does not declare`))
    for (const typed of ["link:1", "1e0", "+1", "01"])
      await expect(refuseOutsideGroup(parsed(["organizations", "show", typed]), { app, env, store })).rejects.toThrow(
        expect.objectContaining({ code: "permission_error", message: expect.stringContaining(`<ref> ${typed}`) }),
      )
    await allowed(env, store, ["search", "1e0 link:1 +1"])
    const note = await store.notes.addNote({ text: "the owner's own" })
    await allowed(env, store, ["tags", "add", "x", "--note", note.id])
  })

  it("puts an event in its calendar's account, so a personal event is refused under work", async () => {
    const env = envOf()
    const store = await seeded(env)
    const calendarAccount = { provider: "google-calendar", account: "home" }
    const accountId = await store.accounts.saveAccount(calendarAccount, { name: null })
    await store.accounts.saveAccountGroup("personal", ["google-calendar:home"])
    const [calendar] = await store.calendar.saveCalendars(
      accountId,
      [{ externalId: "c", title: "Home", timezone: null, accessRole: "owner", primary: true, syncByDefault: true }],
      0,
    )
    const [entry] = await store.calendar.saveEntries(
      calendar?.id as number,
      [
        {
          externalId: "e1",
          kind: "single",
          status: "confirmed",
          title: "Dentist",
          startsAt: 3_600_000,
          endsAt: 7_200_000,
        },
      ],
      0,
    )
    const event = `event:${entry?.eventId}`
    expect(await store.refs.accounts(event)).toEqual([calendarAccount])
    await refused(env, store, ["events", "show", event])
    await allowed({ ...env, MEMO_GROUP_LOCK: "personal" }, store, ["events", "show", String(entry?.eventId)])
  })

  it("refuses a command that does not keep to a group, naming the group, through the program", async () => {
    const env = envOf()
    const definition = {
      app,
      commands: () => [
        new Command("notes").addCommand(new Command("list").action(() => undefined)),
        groupAware(new Command("groups")).addCommand(new Command("list").action(() => undefined)),
      ],
    }
    const call = async (argv: string[]) => {
      const streams = captureStreams()
      const code = await run([...argv, "--no-record"], definition, { streams, tty: false, env })
      return { code, stderr: streams.stderr.join("\n") }
    }
    const notes = await call(["notes", "list"])
    expect(notes.code).not.toBe(0)
    expect(notes.stderr).toMatch(
      /locked to group work \(MEMO_GROUP_LOCK\) — `memo notes list` does not keep to a group/,
    )
    expect(await refuseOutsideGroup(parsed(["show", "x"]), { app, env: {} })).toBeUndefined()
  })

  it("refuses a message of an account outside the group, in an option value", async () => {
    const env = envOf()
    const store = await seeded(env)
    await refused(env, store, ["tags", "add", "x", "--message", "msg:telegram/101/5/9"])
    await allowed(env, store, ["tags", "add", "x", "--message", "msg:telegram/102/5/9"])
  })

  it("refuses a deal, an organization and a person another group's CRM brought, and passes the group's own", async () => {
    const env = envOf()
    const store = await seeded(env)
    const dealOf = async (account: AccountKey) =>
      rowOf(
        env,
        "SELECT d.id FROM deals d JOIN accounts a ON a.id = d.account_id WHERE a.external_id = ?",
        account.account,
      )
    await refused(env, store, ["deals", "update", `deal:${await dealOf(crmOther)}`, "--project", ""])
    await allowed(env, store, ["deals", "update", `deal:${await dealOf(crmWork)}`, "--project", ""])
    await refused(env, store, [
      "deals",
      "update",
      `deal:${await dealOf(crmWork)}`,
      "--project",
      `organization:${await organizationOf(env, crmOther)}`,
    ])
    await refused(env, store, ["tags", "add", "x", "--message", `person:${await personOf(env, crmOther)}`])
    await allowed(env, store, ["tags", "add", "x", "--message", `person:${await personOf(env, crmWork)}`])
  })

  it("maps a file of a notes folder to its folder, in work or personal as the owner put it", async () => {
    const env = envOf()
    const store = await seeded(env)
    const inWork = await store.notes.addFolder({ name: "work notes" })
    const unsorted = await store.notes.addFolder({ name: "home notes" })
    await store.accounts.saveAccountGroup("work", ["telegram:102", "example-crm:work-portal", `notes:${inWork.id}`])
    await store.accounts.saveAccountGroup("personal", [`notes:${unsorted.id}`])
    const fileIn = async (folderId: string) =>
      (await store.notes.saveFileNote({ folderId, path: "a.md", title: null, text: "x" })).note.ref
    const workFile = await fileIn(inWork.id)
    const homeFile = await fileIn(unsorted.id)
    const personal = { ...env, MEMO_GROUP_LOCK: "personal" }
    await allowed(env, store, ["tags", "add", "x", "--message", workFile])
    await refused(env, store, ["tags", "add", "x", "--message", homeFile])
    await refused(personal, store, ["tags", "add", "x", "--message", workFile])
    await allowed(personal, store, ["tags", "add", "x", "--message", homeFile])
  })

  it("passes a thing the owner made, memo's own notes included, in every group", async () => {
    const env = envOf()
    const store = await seeded(env)
    const owned = await store.people.add({ name: "Ана" })
    await allowed(env, store, ["tags", "add", "x", "--message", `person:${owned.uid}`])
    const note = await store.notes.addNote({ text: "the owner's own" })
    await store.accounts.saveAccountGroup("personal", ["telegram:101"])
    for (const group of ["work", "personal"]) {
      await allowed({ ...env, MEMO_GROUP_LOCK: group }, store, ["tags", "add", "x", "--message", `note:${note.id}`])
      await allowed({ ...env, MEMO_GROUP_LOCK: group }, store, ["tags", "add", "x", "--message", `person:${owned.uid}`])
    }
    await refused({ ...env, MEMO_GROUP_LOCK: "personal" }, store, [
      "tags",
      "add",
      "x",
      "--message",
      "msg:telegram/102/5/9",
    ])
  })
})

describe("what a locked run shows of proposals and evidence", () => {
  const lockedGuard = async (env: NodeJS.ProcessEnv, store: MessageStore) =>
    (await groupGuardOf(store, app, env)) as GroupGuard

  it("refuses a proposed action of an outside account, by the id actions confirm takes", async () => {
    const env = envOf()
    const store = await seeded(env)
    const home = await store.proposedActions.propose({ kind: "reply", by: "owner", account: tgPersonal })
    const work = await store.proposedActions.propose({ kind: "reply", by: "owner", account: tgWork })
    const aimed = await store.proposedActions.propose({
      kind: "reply",
      by: "owner",
      account: tgWork,
      target: `organization:${await organizationOf(env, crmOther)}`,
    })
    const confirm = (id: string) => ["actions", "confirm", id]
    await refused(env, store, confirm(home.id))
    await allowed(env, store, confirm(work.id))
    await refused(env, store, confirm(aimed.id))
    await refused(env, store, ["review", "confirm", `${home.id},fact:1,close:Q-1`])
    await allowed(env, store, ["review", "confirm", "fact:1,close:Q-1"])
    await expect(refuseOutsideGroup(parsed(["review", "confirm", "zap:1"]), { app, env, store })).rejects.toThrow(
      /as an id of a kind it does not declare/,
    )
    const otherOrganization = `organization:${await organizationOf(env, crmOther)}`
    const ownOrganization = `organization:${await organizationOf(env, crmWork)}`
    // A key-document suggestion is a link from the document to what it is key to; both ends must be in the group.
    const keyTo = async (to: string) => {
      await store.notes.addNote({ text: "a key document", about: [ownOrganization, to] })
      return rowOf(
        env,
        "SELECT id FROM links WHERE to_type = 'organization' AND to_id = ? ORDER BY id DESC LIMIT 1",
        Number(to.split(":")[1]),
      )
    }
    await refused(env, store, ["review", "confirm", `key:${await keyTo(otherOrganization)}`])
    await allowed(env, store, ["review", "confirm", `key:${await keyTo(ownOrganization)}`])
  })

  it("hides a proposal whose subject or object is outside, and refuses showing or deciding it", async () => {
    const env = envOf()
    const store = await seeded(env)
    const guard = await lockedGuard(env, store)
    const row = (id: string, subject: string, object: string | null): ProposalRow => ({
      id,
      kind: "relationship",
      status: "proposed",
      project: null,
      subject,
      object,
      summary: null,
      proposedBy: { type: "bot", id: "1", name: "claude", kind: "agent" },
      reason: null,
      evidence: ["msg:telegram/102/1/1", "msg:telegram/101/1/1"],
      score: null,
      signals: null,
      parts: null,
      createdAt: "2026-11-07T00:00:00.000Z",
    })
    const rows = [
      row("link:900", `person:${await personOf(env, crmOther)}`, `organization:${await organizationOf(env, crmWork)}`),
      row("link:901", `person:${await personOf(env, crmWork)}`, `organization:${await organizationOf(env, crmWork)}`),
    ]
    const decided: string[] = []
    const registry: ProposalRegistry = {
      register: () => undefined,
      list: async () => ({ items: rows, hasMore: false }),
      get: async (id) => rows.find((one) => one.id === id) as ProposalRow,
      decide: async (ids) => {
        decided.push(...ids)
        return { decided: [], refused: [] }
      },
    }
    const locked = lockedRegistry(registry, guard)
    const { items } = await locked.list({ limit: 10, offset: 0 })
    expect(items.map(({ id }) => id)).toEqual(["link:901"])
    expect(items[0]?.evidence).toEqual(["msg:telegram/102/1/1"])
    await expect(locked.get("link:900")).rejects.toThrow(expect.objectContaining({ code: "permission_error" }))
    const result = await locked.decide(["link:900", "link:901"], { confirm: true, by: "owner" })
    expect(result.refused.map(({ id }) => id)).toEqual(["link:900"])
    expect(decided).toEqual(["link:901"])
  })

  it("drops outside evidence and sources, at any depth, and counts them; owner text stays", async () => {
    const env = envOf()
    const store = await seeded(env)
    const guard = await lockedGuard(env, store)
    expect(await guard.keep(["msg:telegram/101/5/9", "msg:telegram/102/5/9", null])).toEqual({
      kept: ["msg:telegram/102/5/9", null],
      out_of_scope: 1,
    })
    const answer = {
      statement: "Kin said Lockcase",
      sources: [{ ref: "msg:telegram/101/5/9", excerpt: "home" }, { ref: "msg:telegram/102/5/9" }],
      items: [{ evidence: ["chat:telegram/101/5", "chat:telegram/102/5"] }],
    }
    expect(await guard.strip(answer)).toEqual({
      value: {
        statement: "Kin said Lockcase",
        sources: [{ ref: "msg:telegram/102/5/9" }],
        items: [{ evidence: ["chat:telegram/102/5"] }],
      },
      out_of_scope: 2,
    })
    expect(await groupGuardOf(store, app, {})).toBeUndefined()
  })

  it("leaves every value but a dropped reference as it was, so a strict answer schema still reads it", async () => {
    const env = envOf()
    const store = await seeded(env)
    const guard = await lockedGuard(env, store)
    const at = new Date("2026-11-07T00:00:00.000Z")
    const kept = { at, nested: { deep: [1, 2] }, evidence: ["msg:telegram/102/5/9"] }
    const answer = {
      items: [kept, { at, evidence: ["msg:telegram/101/5/9", "msg:telegram/102/5/9"], nested: { deep: [3] } }],
      page: { limit: 2 },
    }
    const schema = v.strictObject({
      items: v.array(
        v.strictObject({
          at: v.date(),
          nested: v.strictObject({ deep: v.array(v.number()) }),
          evidence: v.array(v.string()),
        }),
      ),
      page: v.strictObject({ limit: v.number() }),
    })
    const { value, out_of_scope } = await guard.strip(answer)
    expect(out_of_scope).toBe(1)
    expect(v.parse(schema, value).items[1]?.evidence).toEqual(["msg:telegram/102/5/9"])
    expect(value.items[0]).toBe(kept)
    expect(value.items[1]?.at).toBe(at)
    expect(value.page).toBe(answer.page)
    const untouched = { items: [kept] }
    expect((await guard.strip(untouched)).value).toBe(untouched)
  })
})
