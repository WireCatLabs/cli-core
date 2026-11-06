import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import * as v from "valibot"
import { afterEach, describe, expect, it } from "vitest"
import { answerEntitySchema } from "../../cli/answer-entity.js"
import { commandsCommand } from "../../cli/commands-command.js"
import { provide } from "../../cli/context.js"
import { run } from "../../cli/program.js"
import { runsCommand } from "../../cli/runs/command.js"
import { CRM_OPENS } from "../../domain/providers.js"
import type { AppIdentity } from "../../ports/app.js"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import type { Level } from "../../sends/permissions.js"
import { type MessageStore, openStore } from "../../store/store.js"
import { exampleDeal, exampleLead, exampleOrganization, examplePerson, fakeCrmSource } from "../testing/index.js"
import type { CrmWriteCapabilities } from "../writer.js"
import { addCrmCommands, type CrmCommandOptions, type CrmRun } from "./index.js"

const APP: AppIdentity = {
  command: "crm",
  appName: "example-crm-cli",
  envPrefix: "CRM",
  description: "synthetic",
  version: "1.0.0",
}
const PORTAL = { provider: "example-crm", account: "portal" }

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

const WRITES: CrmWriteCapabilities = {
  kinds: ["deal", "lead"],
  verbs: ["create", "update", "move", "close", "remove"],
  idempotent: false,
}

const setup = async (
  extra: Partial<CrmRun> = {},
  options: Partial<CrmCommandOptions> & {
    permissions?: Record<string, Level>
    idempotent?: boolean
  } = {},
) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "crm-cli-")), "store.db") })
  opened.push(store)
  await store.accounts.registerProvider({
    name: "example-crm",
    kind: "crm",
    aliases: [],
    command: "crm",
    opens: CRM_OPENS,
  })
  const source = fakeCrmSource({ capabilities: { idempotent: options.idempotent ?? false } })
  const home = mkdtempSync(join(tmpdir(), "crm-writes-"))
  const env = { HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, CRM_STATE_DIR: home }
  const writes = () => ({
    writer: source,
    app: APP,
    self: "7",
    env,
    settings: () => ({
      profile: "work",
      permissions: options.permissions ?? {},
      permissionSources: {},
      sendsPerHour: 1000,
    }),
  })
  const journal = () => new SendJournal(sendsPathFor(APP, "work", env)).entries()
  source.put("organization", exampleOrganization("c1"))
  source.put("person", examplePerson("p1", { email: "person@example.com" }))
  source.put(
    "deal",
    exampleDeal("d1", {
      title: "Example website",
      amount: "1500.50",
      currency: "EUR",
      organization: "c1",
      people: [{ externalId: "p1", role: "contact" }],
    }),
  )
  source.put("deal", exampleDeal("d2", { stage: "won" }))
  source.put("lead", exampleLead("l1"))
  const runOf: CrmRun = { profile: "work", account: PORTAL, store, source: () => source, writes, ...extra }
  let data = ""
  const cli = async (...args: string[]) => {
    const root = new Command("crm")
      .exitOverride()
      .configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
      .option("--json")
      .option("--jsonl")
      .option("--offline")
      .option("--full")
      .option("--timeout <duration>")
      .option("--yes")
      .option("--dry-run")
    const { permissions: _permissions, idempotent: _idempotent, ...mount } = options
    addCrmCommands(root, { app: APP, open: async () => runOf, ...mount })
    provide(root, {
      streams: { data: (text: string) => (data += text), diagnostic: () => undefined },
      tty: false,
    } as never)
    data = ""
    await root.parseAsync([...args, "--json"], { from: "user" })
    const envelope = JSON.parse(data) as Record<string, unknown> & { item?: unknown; items?: unknown[] }
    const schema = answerEntitySchema(commandAt(root, args))
    if (!schema) throw new Error(`${args.join(" ")} declares no answer entity`)
    // A --dry-run answers the shared preview, never the command's own entity.
    for (const item of args.includes("--dry-run") ? [] : (envelope.items ?? [envelope.item])) {
      const parsed = v.safeParse(schema, item)
      if (!parsed.success)
        throw new Error(
          `${args.join(" ")}: ${parsed.issues.map((one) => `${v.getDotPath(one)} ${one.message}`).join("; ")}`,
        )
    }
    return envelope as Record<string, unknown> & { item: Record<string, unknown>; items: Record<string, unknown>[] }
  }
  return { store, source, cli, journal }
}

describe("CRM commands", () => {
  it("sync, then read deals, leads, pipelines and stages from the store in the shared shapes", async () => {
    const { cli } = await setup()
    const synced = await cli("sync")
    expect(synced.item).toMatchObject({ state: "complete", complete: true, provider: "example-crm" })
    const deals = await cli("deals", "list")
    expect(deals.items.map(({ external_id }) => external_id).sort()).toEqual(["d1", "d2"])
    const open = await cli("deals", "list", "status:open")
    expect(open.items).toHaveLength(1)
    expect(open.items[0]).toMatchObject({
      title: "Example website",
      amount: "1500.50",
      currency: "EUR",
      account: PORTAL,
      untrusted: expect.arrayContaining(["title"]),
    })
    const shown = await cli("deals", "show", open.items[0]?.ref as string)
    expect(shown.item).toMatchObject({ organization: { name: "Example company c1" }, people: [{ role: "contact" }] })
    expect((await cli("leads", "list")).items).toHaveLength(1)
    const pipelines = await cli("pipelines", "list")
    expect(pipelines.items.map(({ kind }) => kind).sort()).toEqual(["deal", "lead"])
    const funnel = await cli("pipelines", "show", pipelines.items.find(({ kind }) => kind === "deal")?.ref as string)
    expect(funnel.item).toMatchObject({ totals: { items: 2, open: 1, won: 1 } })
    const stages = await cli("stages", "list", "kind:lead")
    expect(stages.items.map(({ name }) => name)).toEqual(["New", "Converted", "Junk"])
  })

  it("pages a list, and shows only this profile's copies", async () => {
    const { cli, store } = await setup()
    await cli("sync")
    const first = await cli("deals", "list", "--limit", "1")
    expect(first.items).toHaveLength(1)
    expect(first.page).toMatchObject({ has_more: true })
    const own = await store.deals.add({ by: "owner", kind: "lead", title: "Owner's own lead" })
    await expect(cli("leads", "show", own.ref)).rejects.toMatchObject({ code: "not_found" })
    await expect(cli("deals", "show", "12")).rejects.toMatchObject({ code: "validation_error" })
  })

  it("a sync its page budget stops answers partial, with the step that goes on", async () => {
    const { cli } = await setup()
    const stopped = await cli("sync", "--max-pages", "4")
    expect(stopped.item).toMatchObject({ state: "partial", stopped: "requests" })
    expect(stopped.meta).toMatchObject({ complete: false })
    expect(stopped.next).toEqual([
      expect.objectContaining({ step: "crm.sync", command: "sync", args: { max_pages: 4 } }),
    ])
    const status = await cli("store", "status")
    expect(status.items.map(({ kind, state }) => [kind, state])).toContainEqual(["deal", "partial"])
  })

  it("search all finds a deal by a word of its title", async () => {
    const { cli } = await setup()
    await cli("sync")
    const found = await cli("search", "all", "website", "--only", "crm")
    expect(found.items).toEqual([
      expect.objectContaining({ kind: "deal", title: "Example website", provider: "example-crm" }),
    ])
  })

  it("pass the command lint every CLI runs on its tree", async () => {
    const definition = {
      app: APP,
      commands: () => {
        const root = new Command("crm")
        addCrmCommands(root, {
          app: APP,
          open: () => Promise.reject(new Error("not opened")),
          writes: { ...WRITES, idempotent: true },
        })
        return [commandsCommand(APP), runsCommand(APP), ...root.commands]
      },
    }
    const streams = captureStreams()
    expect(await run(["commands", "--json"], definition, { streams, tty: false, env: {} })).toBe(0)
    const document = join(mkdtempSync(join(tmpdir(), "crm-lint-")), "commands.json")
    writeFileSync(document, streams.stdout.join(""))
    const lint = spawnSync("node_modules/.bin/cli-dev", ["lint", "--commands", document], { encoding: "utf8" })
    const rules = [...`${lint.stdout}${lint.stderr}`.matchAll(/^(?:high|medium|low)\s+(\S+.*)$/gmu)].map(
      ([, rule]) => rule,
    )
    expect(rules).toEqual([])
    expect(`${lint.stdout}${lint.stderr}`).toMatch(/lint: 0 violations/)
  })
})

describe("CRM write commands", () => {
  const synced = async (options: Parameters<typeof setup>[1] = {}) => {
    const harness = await setup({}, { writes: { ...WRITES, idempotent: options.idempotent ?? false }, ...options })
    await harness.cli("sync")
    const open = await harness.cli("deals", "list", "status:open")
    return { ...harness, ref: open.items[0]?.ref as string }
  }

  it("exist only when the CLI passes the writer's capabilities", () => {
    const root = new Command("crm")
    addCrmCommands(root, { app: APP, open: () => Promise.reject(new Error("not opened")) })
    const deals = root.commands.find((one) => one.name() === "deals")
    expect(deals?.commands.map((one) => one.name())).toEqual(["list", "show"])
  })

  it("create writes to the CRM once, journals it and stores the CRM's copy", async () => {
    const { cli, source, journal } = await synced()
    const made = await cli("deals", "create", "--title", "Example kitchen", "--amount", "15000", "--currency", "eur")
    const deal = made.item.deal as Record<string, unknown>
    expect(deal).toMatchObject({ title: "Example kitchen", amount: "15000.00", currency: "EUR", status: "open" })
    expect(source.writes).toEqual([expect.objectContaining({ verb: "create", kind: "deal" })])
    expect(journal()).toEqual([
      expect.objectContaining({ outcome: "sent", key: "deals.create", operationId: made.item.operation_id }),
    ])
    expect((await cli("deals", "show", deal.ref as string)).item).toMatchObject({ title: "Example kitchen" })
  })

  it("an update that sets a stage also checks the move key, and a won stage the close key", async () => {
    const moveDenied = await synced({ permissions: { "deals.move": "deny" } })
    await expect(moveDenied.cli("deals", "update", moveDenied.ref, "--stage", "Quote sent")).rejects.toMatchObject({
      code: "permission_error",
    })
    const closeDenied = await synced({ permissions: { "deals.close": "deny" } })
    await expect(closeDenied.cli("deals", "update", closeDenied.ref, "--stage", "won")).rejects.toMatchObject({
      code: "permission_error",
    })
    await expect(closeDenied.cli("deals", "move", closeDenied.ref, "Won")).rejects.toMatchObject({
      code: "permission_error",
    })
    expect([...moveDenied.source.writes, ...closeDenied.source.writes]).toEqual([])
    const moved = await closeDenied.cli("deals", "update", closeDenied.ref, "--stage", "Quote sent")
    expect(moved.item.deal).toMatchObject({ stage: "Quote sent" })
  })

  it("giving a record to another CRM user checks crm.assign-others, denied by default", async () => {
    const { cli, ref, source } = await synced()
    await expect(cli("deals", "update", ref, "--owner", "9")).rejects.toMatchObject({ code: "permission_error" })
    expect(source.writes).toEqual([])
    await cli("deals", "update", ref, "--owner", "7")
    expect(source.writes).toHaveLength(1)
  })

  it("move and close write through, and the reason is kept", async () => {
    const { cli, ref } = await synced()
    expect((await cli("deals", "move", ref, "quote sent")).item.deal).toMatchObject({ stage: "Quote sent" })
    const closed = await cli("deals", "close", ref, "lost", "--reason", "Example: chose another supplier")
    expect(closed.item.deal).toMatchObject({ status: "lost", closed_reason: "Example: chose another supplier" })
  })

  it("--dry-run previews a write and sends nothing", async () => {
    const { cli, ref, source } = await synced()
    expect((await cli("deals", "delete", ref, "--dry-run")).item).toMatchObject({ preview: true })
    expect(source.writes).toEqual([])
  })

  it("delete asks first, then marks the copy deleted", async () => {
    const { cli, ref, source } = await synced()
    await expect(cli("deals", "delete", ref)).rejects.toMatchObject({ code: "confirmation_required" })
    expect(source.writes).toEqual([])
    expect((await cli("deals", "delete", ref, "--yes")).item).toMatchObject({ ref, removed: 1 })
    expect((await cli("deals", "list", "status:open")).items).toEqual([])
  })

  it("a lost answer is outcome_unknown, journaled, and never sent again", async () => {
    const plain = await synced()
    plain.source.loseNextAnswer()
    await expect(plain.cli("deals", "update", plain.ref, "--title", "Example lost")).rejects.toMatchObject({
      code: "outcome_unknown",
      message: expect.stringContaining("sync and look"),
    })
    expect(plain.source.writes).toHaveLength(1)
    expect(plain.journal()).toEqual([expect.objectContaining({ outcome: "outcome_unknown", key: "deals.update" })])
    const keyed = await synced({ idempotent: true })
    keyed.source.loseNextAnswer()
    const lost = keyed.cli("deals", "create", "--title", "Example kitchen")
    await expect(lost).rejects.toMatchObject({
      code: "outcome_unknown",
      message: expect.stringContaining("--operation-id"),
    })
  })

  it("--operation-id repeats a write only on a CRM that recognises it", async () => {
    const keyed = await synced({ idempotent: true })
    const first = await keyed.cli("deals", "create", "--title", "Example kitchen", "--operation-id", "op-1")
    const again = await keyed.cli("deals", "create", "--title", "Example kitchen", "--operation-id", "op-1")
    expect((again.item.deal as { ref: string }).ref).toBe((first.item.deal as { ref: string }).ref)
    const plain = await synced()
    await expect(plain.cli("deals", "create", "--title", "x", "--operation-id", "op-1")).rejects.toMatchObject({
      code: "commander.unknownOption",
    })
  })

  it("a custom field that names a neutral one is refused, and --field sets the others", async () => {
    const { cli, ref, source } = await synced()
    await expect(cli("deals", "update", ref, "--field", "stage=won")).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(source.writes).toEqual([])
    await cli("deals", "update", ref, "--field", "UF_CRM_SOURCE=web")
    expect(source.writes).toHaveLength(1)
  })
})
