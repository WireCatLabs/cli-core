import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { metaOf } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import * as v from "valibot"
import { afterEach, describe, expect, it } from "vitest"
import { answerEntitySchema } from "../../cli/answer-entity.js"
import { provide } from "../../cli/context.js"
import type { CrmField } from "../../domain/crm.js"
import { CRM_OPENS } from "../../domain/providers.js"
import type { AppIdentity } from "../../ports/app.js"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import type { Level } from "../../sends/permissions.js"
import { crmIdentityId } from "../../store/sqlite/crm-rows.js"
import { type MessageStore, openStore } from "../../store/store.js"
import { DAILY_FOREIGN_CONTACTS, foreignContactsPathFor } from "../foreign-contacts.js"
import { exampleOrganization, examplePerson, type FakeCrmSourceOptions, fakeCrmSource } from "../testing/index.js"
import { crmAlsoChecks } from "../writer.js"
import { addCrmCommands, type CrmCommandOptions, type CrmRun } from "./index.js"

const APP: AppIdentity = {
  command: "crm",
  appName: "example-crm-cli",
  envPrefix: "CRM",
  description: "synthetic",
  version: "1.0.0",
}
const PORTAL = { provider: "example-crm", account: "portal" }
const TIER: CrmField = {
  code: "UF_TIER",
  label: "Tier",
  type: "enumeration",
  multiple: false,
  filterable: true,
  options: [
    { id: "1", label: "Gold" },
    { id: "2", label: "Silver" },
  ],
}

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const commandAt = (root: Command, argv: readonly string[]): Command => {
  let at = root
  for (const word of argv) {
    const next = at.commands.find((one) => one.name() === word)
    if (!next) break
    at = next
  }
  return at
}

const setup = async (
  fake: FakeCrmSourceOptions = {},
  options: Partial<CrmCommandOptions> & { permissions?: Record<string, Level> } = {},
) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "crm-records-")), "store.db") })
  opened.push(store)
  await store.accounts.registerProvider({
    name: "example-crm",
    kind: "crm",
    aliases: [],
    command: "crm",
    opens: CRM_OPENS,
  })
  const source = fakeCrmSource({ self: "7", ...fake })
  source.setFields("person", [TIER])
  for (const id of ["p1", "p2", "p3"])
    source.put(
      "person",
      examplePerson(id, {
        name: id === "p2" ? "Anna Example" : `Example person ${id}`,
        email: `${id}@example.com`,
        assignee: id === "p3" ? "7" : "9",
        ...(id === "p3" ? { contactTypes: { "p3@example.com": "WORK" } } : {}),
        createdAt: Date.UTC(2026, 10, Number(id.slice(1))),
        metadata: {
          UF_TIER: { label: "Tier", value: id === "p1" ? "Gold" : "Silver", option_id: id === "p1" ? "1" : "2" },
        },
      }),
    )
  source.put("organization", exampleOrganization("c1", { own: true }))
  const home = mkdtempSync(join(tmpdir(), "crm-records-home-"))
  const env = { HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, CRM_STATE_DIR: home }
  const runOf: CrmRun = {
    profile: "work",
    account: PORTAL,
    store,
    source: () => source,
    env,
    writes: () => ({
      writer: source,
      app: APP,
      self: "7",
      env,
      settings: () => ({
        profile: "work",
        permissions: options.permissions ?? {},
        permissionSources: {},
        sendsPerHour: 0,
      }),
    }),
  }
  let data = ""
  let root = new Command("crm")
  const printed = async (args: string[]) => {
    root = new Command("crm")
      .exitOverride()
      .configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
      .option("--json")
      .option("--fields <paths>")
      .option("--offline")
      .option("--yes")
    const { permissions: _permissions, ...mount } = options
    addCrmCommands(root, {
      app: APP,
      open: async () => runOf,
      live: ["person", "organization", "user"],
      writes: { kinds: ["deal", "person", "organization"], verbs: ["create", "update"], idempotent: false },
      now: () => Date.UTC(2026, 10, 15, 12),
      ...mount,
    })
    provide(root, {
      streams: { data: (text: string) => (data += text), diagnostic: () => undefined },
      tty: false,
    } as never)
    data = ""
    await root.parseAsync(args, { from: "user" })
    return data
  }
  const cli = async (...args: string[]) => {
    await printed([...args, "--json"])
    const envelope = JSON.parse(data) as Record<string, unknown> & { item?: unknown; items?: unknown[] }
    const schema = answerEntitySchema(commandAt(root, args))
    if (!schema) throw new Error(`${args.join(" ")} declares no answer entity`)
    for (const item of envelope.items ?? [envelope.item]) {
      const parsed = v.safeParse(schema, item)
      if (!parsed.success) throw new Error(`${args.join(" ")}: ${parsed.issues.map((one) => one.message).join("; ")}`)
    }
    return envelope as Record<string, unknown> & { item: Record<string, unknown>; items: Record<string, unknown>[] }
  }
  const journal = () => new SendJournal(sendsPathFor(APP, "work", env)).entries()
  const quotaFile = () => foreignContactsPathFor(APP, PORTAL, env, "7")
  return { source, store, cli, printed, journal, quotaFile, root: () => root }
}

describe("people, organizations and users, read live", () => {
  it("are mounted only for what the CLI says its source reads live", () => {
    const root = new Command("crm")
    addCrmCommands(root, { app: APP, open: () => Promise.reject(new Error("not opened")), live: ["user"] })
    expect(root.commands.map((one) => one.name())).toContain("users")
    expect(root.commands.map((one) => one.name())).not.toContain("people")
  })

  it("people list pages the CRM's own pages, newest first, in the shared shape", async () => {
    const { cli, source } = await setup()
    const first = await cli("people", "list", "--limit", "2")
    expect(first.items.map(({ id }) => id)).toEqual(["p3", "p2"])
    expect(first.page).toMatchObject({ has_more: true, limit: 2 })
    expect(first.items[0]).toMatchObject({
      name: "Example person p3",
      emails: [{ value: "p3@example.com", type: "WORK" }],
      assigned_to: "7",
      created_at: "2026-11-03T00:00:00.000Z",
      untrusted: expect.arrayContaining(["name", "provider_metadata"]),
    })
    const second = await cli("people", "list", "--limit", "2", "--page", "2")
    expect(second.items.map(({ id }) => id)).toEqual(["p1"])
    expect(second.page).toMatchObject({ has_more: false })
    expect(source.calls.list).toBe(2)
  })

  it("narrows by name, by a shared field and by a custom field's option label", async () => {
    const { cli } = await setup()
    expect((await cli("people", "list", "anna")).items.map(({ id }) => id)).toEqual(["p2"])
    expect((await cli("people", "list", "assigned_to:7")).items.map(({ id }) => id)).toEqual(["p3"])
    expect((await cli("people", "list", "Tier:Gold")).items.map(({ id }) => id)).toEqual(["p1"])
    expect((await cli("people", "list", "created_at:[2026-11-02 TO 2026-11-03]")).items.map(({ id }) => id)).toEqual([
      "p3",
      "p2",
    ])
  })

  it("refuses a custom field it does not know in the query or in --json, and --offline", async () => {
    const { cli, printed, root } = await setup()
    await expect(cli("people", "list", "Colour:red")).rejects.toMatchObject({ details: { reason: "field.unknown" } })
    await expect(
      printed(["people", "list", "--json", "--fields", "id,provider_metadata.UF_NOPE"]),
    ).rejects.toMatchObject({
      details: { reason: "field.unknown", param: "--json" },
    })
    for (const path of [
      ["people", "list"],
      ["people", "show"],
      ["users", "list"],
      ["organizations", "create"],
    ])
      expect(metaOf(commandAt(root(), path)).offline, path.join(" ")).toBe(false)
  })

  it("prints a CSV with the custom fields under their labels", async () => {
    const { printed } = await setup()
    const table = await printed(["people", "list", "--format", "csv", "--limit", "1"])
    const [header, row] = table.trim().split(/\r?\n/u)
    expect(header).toContain("Tier")
    expect(row).toContain("Silver")
    expect(row).toContain("p3@example.com")
    expect(row).not.toContain("WORK")
  })

  it("show reads one by its id, and an unknown one is not_found", async () => {
    const { cli } = await setup()
    expect((await cli("people", "show", "p2")).item).toMatchObject({ id: "p2", name: "Anna Example" })
    expect((await cli("organizations", "show", "c1")).item).toMatchObject({ id: "c1", own: true })
    await expect(cli("people", "show", "p404")).rejects.toMatchObject({ code: "not_found" })
  })

  it("a non-admin sees foreign contacts without phones and e-mails, and show spends the day's slots", async () => {
    const { cli } = await setup({ admin: false, ownClients: { person: ["p1"] } })
    const listed = await cli("people", "list")
    expect(Object.fromEntries(listed.items.map(({ id, emails }) => [id, emails ?? null]))).toEqual({
      p1: [{ value: "p1@example.com", type: null }],
      p2: null,
      p3: [{ value: "p3@example.com", type: "WORK" }],
    })
    expect((await cli("people", "show", "p2")).item).toMatchObject({
      emails: [{ value: "p2@example.com", type: null }],
    })
  })

  it("an administrator sees every contact whole and spends nothing", async () => {
    const { cli, quotaFile } = await setup({ admin: true })
    expect((await cli("people", "list")).items.every(({ emails }) => Array.isArray(emails))).toBe(true)
    await cli("people", "show", "p2")
    expect(existsSync(quotaFile())).toBe(false)
  })

  it("the 101st foreign contact a day is refused by show, while an own client still shows", async () => {
    const { cli, quotaFile } = await setup({ admin: false })
    mkdirSync(dirname(quotaFile()), { recursive: true })
    const seen = Array.from({ length: DAILY_FOREIGN_CONTACTS }, (_, at) => `person:old-${at}`)
    writeFileSync(quotaFile(), JSON.stringify({ day: "2026-11-15", seen }))
    await expect(cli("people", "show", "p2")).rejects.toMatchObject({
      details: { reason: "crm.foreign-contacts-spent" },
    })
    expect((await cli("people", "show", "p3")).item).toMatchObject({
      emails: [{ value: "p3@example.com", type: "WORK" }],
    })
  })

  it("show finds one by its exact name too, and refuses a name two share, naming both (PAR-1)", async () => {
    const { cli, source } = await setup()
    expect((await cli("people", "show", "anna example")).item).toMatchObject({ id: "p2" })
    source.put("person", examplePerson("p4", { name: "Anna Example" }))
    await expect(cli("people", "show", "Anna Example")).rejects.toMatchObject({
      details: {
        reason: "crm.record-ambiguous",
        candidates: expect.arrayContaining([
          expect.objectContaining({ id: "p2" }),
          expect.objectContaining({ id: "p4" }),
        ]),
      },
    })
    await expect(cli("people", "show", "Nobody Example")).rejects.toMatchObject({ code: "not_found" })
  })

  it("users show refuses a malformed id, and a run reads the CRM's users once (NIT-1, PERF-1)", async () => {
    const { cli, source } = await setup()
    let reads = 0
    Object.assign(source, {
      users: async () => {
        reads += 1
        return [{ externalId: "7", name: "Emma Example", active: true }]
      },
    })
    await expect(cli("users", "show", "../7")).rejects.toMatchObject({ details: { reason: "ref.malformed" } })
    expect((await cli("users", "show", "7")).item).toMatchObject({ id: "7" })
    expect((await cli("users", "list")).items).toHaveLength(1)
    expect(reads).toBe(1)
  })

  it("users list filters the CRM's users by name and active, and show finds one", async () => {
    const { cli, source } = await setup()
    Object.assign(source, {
      users: async () => [
        { externalId: "7", name: "Emma Example", email: "emma@example.com", active: true, departments: ["1"] },
        { externalId: "8", name: "Old Example", active: false },
      ],
    })
    expect((await cli("users", "list", "active:true")).items.map(({ id }) => id)).toEqual(["7"])
    expect((await cli("users", "list", "old")).items.map(({ id }) => id)).toEqual(["8"])
    expect((await cli("users", "show", "7")).item).toMatchObject({ email: "emma@example.com", department_ids: ["1"] })
  })
})

describe("people and organizations writes", () => {
  it("create writes once, journals it, and stores the CRM's copy as a sync would", async () => {
    const { cli, source, store, journal } = await setup()
    await cli("sync")
    const made = await cli(
      "people",
      "create",
      "--first-name",
      "Olga",
      "--last-name",
      "Example",
      "--field",
      "Tier=Silver",
    )
    expect(made.item).toMatchObject({
      operation_id: expect.any(String),
      person: { name: "Olga Example", provider_metadata: { UF_TIER: { option_id: "2" } } },
    })
    expect(source.writes).toMatchObject([{ verb: "create", kind: "person" }])
    expect(journal().map(({ key }) => key)).toEqual(["people.create"])
    const id = (made.item.person as { id: string }).id
    expect((await store.crm.count(PORTAL, "person")) > 0).toBe(true)
    const changed = await cli("people", "update", id, "--position", "Buyer")
    expect(changed.item).toMatchObject({ person: { id, position: "Buyer", name: "Olga Example" } })
  })

  it("a company takes a name, refuses a contact's field, and checks crm.assign-others for another owner", async () => {
    const { cli, source } = await setup()
    expect((await cli("organizations", "create", "--name", "Example LLC")).item).toMatchObject({
      organization: { name: "Example LLC" },
    })
    await expect(cli("organizations", "create")).rejects.toMatchObject({ details: { reason: "crm.record-field" } })
    await expect(cli("organizations", "update", "c1", "--owner", "9")).rejects.toMatchObject({
      code: "permission_error",
    })
    expect(source.writes).toHaveLength(1)
  })

  it("people.create denied writes nothing; the dry-run keys name assign-others", async () => {
    const { cli, source } = await setup({}, { permissions: { "people.create": "deny" } })
    await expect(cli("people", "create", "--name", "Example")).rejects.toMatchObject({ code: "permission_error" })
    expect(source.writes).toEqual([])
    expect(crmAlsoChecks()(["people", "create"])).toEqual([
      { key: "crm.assign-others", when: "--owner other than the sign-in's user" },
    ])
  })

  it("a non-admin's write of a foreign contact answers it stripped, stores nothing, spends nothing (SEC-1)", async () => {
    const { cli, store, quotaFile } = await setup({ admin: false })
    const before = await store.crm.count(PORTAL, "person")
    const foreign = await cli("people", "update", "p2", "--position", "Buyer")
    expect(foreign.item).toMatchObject({ stored: false, person: { id: "p2", position: "Buyer" } })
    expect(foreign.item.person).not.toHaveProperty("emails")
    expect(await store.crm.count(PORTAL, "person")).toBe(before)
    expect(existsSync(quotaFile())).toBe(false)
    const mine = await cli("people", "update", "p3", "--position", "Buyer")
    expect(mine.item).toMatchObject({ stored: true, person: { emails: [{ value: "p3@example.com", type: "WORK" }] } })
    expect(await store.crm.count(PORTAL, "person")).toBe(before + 1)
  })

  it("a write of a contact the copy never held does not add it", async () => {
    const { cli, store } = await setup({ admin: false })
    expect((await cli("people", "update", "p2", "--position", "Buyer")).item).toMatchObject({ stored: false })
    expect(await store.people.personOf({ provider: PORTAL.provider, id: crmIdentityId(PORTAL, "p2") })).toBeUndefined()
  })

  it("an update that hands an own company to another owner removes it from the copy (R-2)", async () => {
    const { cli, store, source } = await setup({ admin: false }, { permissions: { "crm.assign-others": "allow" } })
    source.put("organization", exampleOrganization("c2", { assignee: "7" }))
    await cli("organizations", "update", "c2", "--name", "Example Co")
    const before = await store.crm.count(PORTAL, "organization")
    expect((await cli("organizations", "update", "c2", "--owner", "9")).item).toMatchObject({ stored: false })
    expect(await store.crm.count(PORTAL, "organization")).toBe(before - 1)
  })

  it("an update that hands an own contact to another owner removes it and its phones from the copy (R-2)", async () => {
    const { cli, store } = await setup({ admin: false }, { permissions: { "crm.assign-others": "allow" } })
    await cli("people", "update", "p3", "--phone", "+34600000003")
    const identity = { provider: PORTAL.provider, id: crmIdentityId(PORTAL, "p3") }
    expect(await store.people.personOf(identity)).toBeDefined()
    const before = await store.crm.count(PORTAL, "person")
    expect((await cli("people", "update", "p3", "--owner", "9")).item).toMatchObject({ stored: false, removed: true })
    expect(await store.crm.count(PORTAL, "person")).toBe(before - 1)
    expect(await store.people.personOf(identity)).toBeUndefined()
  })

  it("--email and --phone, repeated, replace a contact's and a company's lists; a national phone is refused", async () => {
    const { cli, source } = await setup()
    const person = await cli("people", "update", "p3", "--email", "a@example.com", "--email", "b@example.com")
    expect(person.item.person).toMatchObject({
      emails: [{ value: "a@example.com" }, { value: "b@example.com" }],
    })
    const company = await cli("organizations", "create", "--name", "Example LLC", "--phone", "+34 600 111 222")
    expect(company.item.organization).toMatchObject({ phones: [{ value: "+34600111222" }] })
    await expect(cli("people", "update", "p3", "--phone", "600111222")).rejects.toMatchObject({
      details: { reason: "crm.record-field", param: "--phone" },
    })
    expect(source.writes).toHaveLength(2)
    const cleared = await cli("people", "update", "p3", "--phone", "", "--email", "")
    expect(cleared.item.person).toMatchObject({ emails: [], phones: [] })
  })

  it("a lost answer is outcome_unknown, journaled, and the copy not stored", async () => {
    const { cli, source, store } = await setup()
    const before = await store.crm.count(PORTAL, "person")
    source.loseNextAnswer()
    await expect(cli("people", "create", "--name", "Example lost")).rejects.toMatchObject({
      code: "outcome_unknown",
      details: { operation_id: expect.any(String) },
    })
    expect(await store.crm.count(PORTAL, "person")).toBe(before)
  })
})
