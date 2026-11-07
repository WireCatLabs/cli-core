import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { syncCrm } from "../crm/index.js"
import { exampleDeal, exampleOrganization, examplePerson, fakeCrmSource } from "../crm/testing/index.js"
import { openCache } from "../store/open.js"
import { storePath } from "../store/path.js"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
import { groupAware, refuseOutsideGroup } from "./group-lock.js"
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

/** A group-aware `tags add <tag> --message <ref>` and `deals update <deal>` as memo's would be, parsed. */
const parsed = (argv: string[]) => {
  const program = new Command().exitOverride()
  const tags = groupAware(new Command("tags"))
  tags
    .command("add")
    .argument("<tag>")
    .option("--message <ref>")
    .action(() => undefined)
  const deals = groupAware(new Command("deals"))
  deals
    .command("update")
    .argument("<deal>")
    .option("--project <ref>")
    .action(() => undefined)
  program.addCommand(tags).addCommand(deals)
  program
    .command("show")
    .argument("<ref>")
    .action(() => undefined)
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

  it("passes a thing the owner made, and keeps memo's own notes in personal", async () => {
    const env = envOf()
    const store = await seeded(env)
    const owned = await store.people.add({ name: "Ана" })
    await allowed(env, store, ["tags", "add", "x", "--message", `person:${owned.id}`])
    const note = await store.notes.addNote({ text: "the owner's own" })
    await refused(env, store, ["tags", "add", "x", "--message", `note:${note.id}`])
    await allowed({ ...env, MEMO_GROUP_LOCK: "personal" }, store, ["tags", "add", "x", "--message", `note:${note.id}`])
  })
})
