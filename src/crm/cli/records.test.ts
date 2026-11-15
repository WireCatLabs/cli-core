import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
import { type MessageStore, openStore } from "../../store/store.js"
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
  return { source, store, cli, printed, journal, root: () => root }
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
      emails: ["p3@example.com"],
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
      p1: ["p1@example.com"],
      p2: null,
      p3: ["p3@example.com"],
    })
    expect((await cli("people", "show", "p2")).item).toMatchObject({ emails: ["p2@example.com"] })
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
