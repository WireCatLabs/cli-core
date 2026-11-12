import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describeProgram } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import * as v from "valibot"
import { afterEach, describe, expect, it } from "vitest"
import { answerEntitySchema } from "../../cli/answer-entity.js"
import { commandsCommand } from "../../cli/commands-command.js"
import { provide } from "../../cli/context.js"
import { run } from "../../cli/program.js"
import { runsCommand } from "../../cli/runs/command.js"
import { CRM_OPENS } from "../../domain/providers.js"
import { toolsFromCommands } from "../../mcp/agent.js"
import type { AppIdentity } from "../../ports/app.js"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import type { Level } from "../../sends/permissions.js"
import { dealContext } from "../../services/deal-context.js"
import { openCache } from "../../store/open.js"
import { crmSettingKey, saveCrmSetting } from "../../store/sqlite/crm-settings.js"
import { type MessageStore, openStore } from "../../store/store.js"
import {
  exampleDeal,
  exampleLead,
  exampleOrganization,
  examplePerson,
  fakeCrmSource,
  SALES_PIPELINE,
} from "../testing/index.js"
import { type CrmWriteCapabilities, crmAlsoChecks } from "../writer.js"
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
  const path = join(mkdtempSync(join(tmpdir(), "crm-cli-")), "store.db")
  const store = await openStore({ path })
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
  const alsoChecks: { value?: (kind: string, verb: string) => readonly string[] } = {}
  const writes = () => ({
    ...(alsoChecks.value ? { alsoChecks: alsoChecks.value } : {}),
    writer: source,
    app: APP,
    self: "7",
    env,
    settings: () => ({
      profile: "work",
      permissions: options.permissions ?? {},
      permissionSources: {},
      // A CRM limits its own rate: a write never reads the profile's send limit, so 0 refuses nothing.
      sendsPerHour: 0,
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
  let root = new Command("crm")
  const printed = async (args: string[], tty = false) => {
    root = new Command("crm")
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
      tty,
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
  return { path, store, source, cli, printed, journal, alsoChecks, run: runOf }
}

describe("CRM commands", () => {
  it("sync, then read deals, leads, pipelines and stages from the store in the shared shapes", async () => {
    const { cli } = await setup()
    const synced = await cli("sync")
    expect(synced.item).toMatchObject({ state: "complete", complete: true, provider: "example-crm" })
    const status = await cli("store", "status")
    expect(status.items.find(({ kind }) => kind === "deal")).toMatchObject({
      scope: { setting: "mine", explicit: false, applied: { mode: "all" } },
    })
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

  it("fields list answers a kind's synced fields in b24's shape, pages them, and refuses an unknown kind", async () => {
    const { cli, source } = await setup()
    source.setFields("person", [
      { code: "UF_NOTE", label: "Note", type: "string", multiple: true, filterable: false },
      { code: "UF_TIER", label: null, type: "integer", multiple: false, filterable: true },
    ])
    expect((await cli("fields", "list", "deals")).items).toEqual([])
    await cli("sync")
    expect((await cli("fields", "list", "deals")).items).toEqual([
      {
        code: "UF_SOURCE",
        label: "Source",
        type: "enumeration",
        multiple: false,
        filterable: true,
        options: [
          { id: "1", label: "Website" },
          { id: "2", label: "Fair" },
        ],
        untrusted: ["label", "options.label"],
      },
    ])
    const first = await cli("fields", "list", "people", "--limit", "1")
    expect(first.items.map(({ code }) => code)).toEqual(["UF_NOTE"])
    expect(first.page).toMatchObject({ has_more: true, limit: 1 })
    expect((await cli("fields", "list", "people", "--limit", "1", "--all")).items).toHaveLength(2)
    await expect(cli("fields", "list", "products")).rejects.toMatchObject({
      code: "validation_error",
      details: { reason: "field.unknown-kind", allowed: ["deals", "leads", "people", "organizations"] },
    })
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

  it("pipelines show is the board: each stage's deals and their sum per currency, exact and apart", async () => {
    const { cli, printed, source } = await setup()
    source.setPipelines("lead", [])
    source.put("deal", exampleDeal("d3", { amount: "0.10", currency: "EUR" }))
    source.put("deal", exampleDeal("d4", { amount: "0.20", currency: "EUR" }))
    source.put("deal", exampleDeal("d5", { stage: "quote", amount: "200", currency: "USD" }))
    source.put("deal", exampleDeal("d6"))
    await cli("sync")
    const board = await cli("pipelines", "show")
    expect(board.item).toMatchObject({ name: "Example sales", kind: "deal", account: PORTAL })
    expect(board.item.stages).toEqual([
      expect.objectContaining({
        name: "New",
        outcome: "open",
        items: 4,
        amounts: [{ amount: "1500.80", currency: "EUR", items: 3 }],
      }),
      expect.objectContaining({
        name: "Quote sent",
        items: 1,
        amounts: [{ amount: "200.00", currency: "USD", items: 1 }],
      }),
      expect.objectContaining({ name: "Won", outcome: "won", items: 1, amounts: [] }),
      expect.objectContaining({ name: "Lost", outcome: "lost", items: 0, amounts: [] }),
    ])
    const text = await printed(["pipelines", "show"], true)
    expect(text).toContain("Example sales (pipeline:")
    expect(text).toContain("1 500.80 EUR")
    expect(text).toContain("in open stages: 5 · 1 500.80 EUR, 200.00 USD")
    expect(text).toContain("won: 1 · lost: 0 · win rate 100%")
  })

  it("pipelines show names the pipeline when the CRM has several, and never reads the owner's own", async () => {
    const { cli, source, store } = await setup()
    source.setPipelines("deal", [SALES_PIPELINE, { ...SALES_PIPELINE, externalId: "deal-2", name: "Example repairs" }])
    source.put("deal", exampleDeal("d3", { pipeline: "deal-2", amount: "50", currency: "EUR" }))
    await cli("sync")
    const refused = cli("pipelines", "show")
    await expect(refused).rejects.toMatchObject({
      code: "validation_error",
      details: { reason: "crm.pipeline-required", param: "pipeline", allowed: expect.any(Array) },
    })
    await expect(refused).rejects.toThrow(/3 pipelines; name one: Example leads \(pipeline:\d+\), Example repairs/)
    const repairs = await cli("pipelines", "show", "example repairs")
    expect(repairs.item.stages).toContainEqual(
      expect.objectContaining({ name: "New", items: 1, amounts: [{ amount: "50.00", currency: "EUR", items: 1 }] }),
    )
    await store.deals.addPipeline({ by: "owner", kind: "deal", name: "Own", stages: ["Lead"] })
    await expect(cli("pipelines", "show", "Own")).rejects.toMatchObject({ code: "not_found" })
  })

  it("a sync its page budget stops answers partial, with the step that goes on", async () => {
    const { cli } = await setup()
    const stopped = await cli("sync", "--max-pages", "8")
    expect(stopped.item).toMatchObject({ state: "partial", stopped: "requests" })
    expect(stopped.meta).toMatchObject({ complete: false })
    expect(stopped.next).toEqual([
      expect.objectContaining({ step: "crm.sync", command: "sync", args: { max_pages: 8 } }),
    ])
    const status = await cli("store", "status")
    expect(status.items.map(({ kind, state }) => [kind, state])).toContainEqual(["deal", "partial"])
  })

  it("a sync that fails on a malformed unassigned setting offers no retry and names the setting to change", async () => {
    const scoped = fakeCrmSource({ self: "7" })
    const { path, cli } = await setup({ source: () => scoped })
    const database = await openCache(path)
    database
      .prepare("INSERT INTO store_settings (key, value, at) VALUES (?, ?, 1)")
      .run(`crm.${PORTAL.provider}:${PORTAL.account}.unassigned`, JSON.stringify(["bot"]))
    database.close()
    const failed = await cli("sync")
    expect(failed.next).toBeUndefined()
    expect(failed.item.hint).toContain(
      `fix the setting: crm config set crm.${PORTAL.provider}:${PORTAL.account}.unassigned`,
    )
    expect(failed.meta).toMatchObject({
      issues: expect.arrayContaining([{ code: "validation_error", reason: "sync.partial", source: "crm:deal" }]),
    })
  })

  it("store apply counts the contacts scope mine would remove, and removes them only with --yes under mine", async () => {
    const { path, source, cli, store } = await setup()
    source.put("person", examplePerson("p2"))
    source.put("deal", exampleDeal("d3", { assignee: "9", people: [{ externalId: "p2", role: "contact" }] }))
    await cli("sync")
    const set = async (name: string, value: string) => {
      const database = await openCache(path)
      database
        .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, 1)")
        .run(`crm.${PORTAL.provider}:${PORTAL.account}.${name}`, JSON.stringify(value))
      database.close()
    }
    await set("self", "7")
    await set("scope", "all")
    const counted = { contacts: 1, persons: 1, persons_kept: 0, names: 0 }
    expect((await cli("store", "apply")).item).toEqual({ ...counted, applied: false })
    await expect(cli("store", "apply", "--yes")).rejects.toMatchObject({ code: "validation_error" })
    expect(await store.crm.count(PORTAL, "person")).toBe(2)
    await set("scope", "mine")
    expect((await cli("store", "apply", "--yes")).item).toEqual({ ...counted, applied: true })
    expect(await store.crm.count(PORTAL, "person")).toBe(1)
  })

  it("search all finds a deal by a word of its title", async () => {
    const { cli } = await setup()
    await cli("sync")
    const found = await cli("search", "all", "website", "--only", "crm")
    expect(found.items).toEqual([
      expect.objectContaining({ kind: "deal", title: "Example website", provider: "example-crm" }),
    ])
  })

  it("search all in a CLI without models names the tools that have the download, never its own", async () => {
    const { cli } = await setup()
    await cli("sync")
    const found = await cli("search", "all", "website")
    const hints = JSON.stringify(found.missing)
    expect(hints).toContain("embeddinggemma is not downloaded")
    expect(hints).not.toContain("crm models download")
    expect(hints).toContain("(tg, max or wa)")
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
    const folder = mkdtempSync(join(tmpdir(), "crm-lint-"))
    const document = join(folder, "commands.json")
    writeFileSync(document, streams.stdout.join(""))
    // Run from an empty folder: from the repository, cli-dev also reads cli-core's src and its baseline.
    const lint = spawnSync(join(process.cwd(), "node_modules/.bin/cli-dev"), ["lint", "--commands", document], {
      cwd: folder,
      encoding: "utf8",
    })
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

  it("refuses to move a row of another account than the profile's live one, and writes nothing", async () => {
    const { cli, ref, source, run } = await synced()
    Object.assign(run, { account: { provider: "example-crm", account: "other-portal" } })
    await expect(cli("deals", "move", ref, "Quote sent")).rejects.toMatchObject({ code: "not_found" })
    await expect(cli("deals", "move", "d1", "Quote sent")).rejects.toMatchObject({ code: "validation_error" })
    expect(source.writes).toEqual([])
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

  it("move to a base stage's stage:<id> writes the one stage mapped there, and refuses many or none", async () => {
    const { cli, ref, store, source } = await synced()
    await store.baseStages.confirm({ all: true })
    const base = await store.baseStages.show("deal")
    // The owner's language is unset, so the default names are Russian: columns by place.
    const at = (name: "Proposal" | "Negotiation") => base.stages[name === "Proposal" ? 2 : 3]?.ref as string
    const moved = await cli("deals", "move", ref, at("Negotiation"))
    expect(moved.item.deal).toMatchObject({ stage: "Quote sent", base_stage: { ref: at("Negotiation") } })

    const first = (await store.baseStages.mappings({ kind: "deal" })).find(({ name }) => name === "New")?.ref as string
    await store.baseStages.map(first, at("Negotiation"))
    const refused = cli("deals", "move", ref, at("Negotiation"))
    await expect(refused).rejects.toMatchObject({
      code: "validation_error",
      details: {
        reason: "stage.choice-required",
        candidates: [
          { ref: first, name: "New", external_id: "new", outcome: "open" },
          expect.objectContaining({ name: "Quote sent" }),
        ],
      },
    })
    await expect(cli("deals", "move", ref, at("Proposal"))).rejects.toMatchObject({
      details: { reason: "stage.unmapped" },
    })
    expect(source.writes).toHaveLength(1)
    expect((await cli("deals", "move", ref, first)).item.deal).toMatchObject({ stage: "New" })
    await store.crm.savePipelines({ provider: "example-crm", account: "portal-other" }, "deal", [
      {
        externalId: "x",
        name: "Elsewhere",
        stages: [{ externalId: "x1", name: "Open", position: 1, outcome: "open" }],
      },
    ])
    await store.crm.saveItems({ provider: "example-crm", account: "portal-other" }, "deal", [
      { externalId: "far", title: "Far", pipeline: "x", stage: "x1" },
    ])
    const far = (await store.crm.refOf({ provider: "example-crm", account: "portal-other" }, "deal", "far")) as string
    await expect(cli("deals", "move", far, at("Negotiation"))).rejects.toMatchObject({ code: "not_found" })
  })

  it("a refused move to a base stage prints the candidates in its JSON error", async () => {
    const { store } = await synced()
    await store.baseStages.confirm({ all: true })
    const base = await store.baseStages.show("deal")
    const negotiation = base.stages[3]?.ref as string
    const first = (await store.baseStages.mappings({ kind: "deal" })).find(({ name }) => name === "New")?.ref as string
    await store.baseStages.map(first, negotiation)
    const ref = (await store.deals.list({ status: "open" })).items[0]?.ref as string
    const definition = {
      app: APP,
      commands: () => {
        const root = new Command("crm")
        addCrmCommands(root, {
          app: APP,
          open: async () => ({
            profile: "work",
            account: PORTAL,
            store,
            source: () => fakeCrmSource(),
            writes: () => ({}) as never,
          }),
          writes: WRITES,
        })
        return [...root.commands]
      },
    }
    const streams = captureStreams()
    expect(await run(["deals", "move", ref, negotiation, "--json"], definition, { streams, tty: false, env: {} })).toBe(
      2,
    )
    const printed = JSON.parse([...streams.stdout, ...streams.stderr].join("").trim().split("\n").at(-1) as string)
    expect(printed.error).toMatchObject({
      code: "validation_error",
      reason: "stage.choice-required",
      details: {
        candidates: [
          { ref: first, name: "New", external_id: "new", outcome: "open" },
          expect.objectContaining({ name: "Quote sent", external_id: "quote" }),
        ],
      },
    })
  })

  it("are MCP writes, and --field takes a list", () => {
    const root = new Command("crm")
    addCrmCommands(root, { app: APP, open: () => Promise.reject(new Error("not opened")), writes: WRITES })
    const tools = toolsFromCommands(describeProgram(root))
    const update = tools.find(({ command }) => command === "deals update")
    expect(update?.writes).toBe(true)
    expect(JSON.stringify(update?.input.entries.field)).toContain("array")
    expect(tools.find(({ command }) => command === "deals list")?.writes).toBe(false)
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

  it("--field takes a field by label and an option by label, and refuses a neutral or unknown one", async () => {
    const { cli, ref, source } = await synced()
    for (const name of ["stage", "UF_CRM_NOTE"])
      await expect(cli("deals", "update", ref, "--field", `${name}=won`)).rejects.toMatchObject({
        code: "validation_error",
        details: { reason: "field.unknown" },
      })
    await expect(cli("deals", "update", ref, "--field", "source=Mail")).rejects.toMatchObject({
      details: { reason: "field.unknown-option" },
    })
    await expect(cli("deals", "update", ref, "--field", "source=1", "--field", "source=2")).rejects.toMatchObject({
      details: { reason: "deal.field", field: "UF_SOURCE" },
    })
    expect(source.writes).toEqual([])
    const done = await cli("deals", "update", ref, "--field", "Source=fair")
    expect(done.item.deal).toMatchObject({
      provider_metadata: { UF_SOURCE: { label: "Source", value: "Fair", option_id: "2" } },
    })
    expect(done.item.untrusted).toContain("deal.title")
  })

  it("--field gathers a multiple field's repeats, refuses a label two fields share, and clears with an empty value", async () => {
    const { cli, ref, source } = await synced()
    const tag = { code: "UF_TAGS", label: "Tags", type: "string", multiple: true, filterable: false }
    source.setFields("deal", [
      tag,
      { ...tag, code: "UF_TAG_OLD", multiple: false },
      { ...tag, code: "UF_NOTE", label: "Note", multiple: false },
    ])
    await cli("sync")
    await expect(cli("deals", "update", ref, "--field", "Tags=a")).rejects.toMatchObject({
      details: { reason: "field.ambiguous", candidates: [{ code: "UF_TAGS" }, { code: "UF_TAG_OLD" }] },
    })
    const set = await cli("deals", "update", ref, "--field", "UF_TAGS=a", "--field", "UF_TAGS=b", "--field", "note=x")
    expect(set.item.deal).toMatchObject({
      provider_metadata: { UF_TAGS: { label: "Tags", value: ["a", "b"] }, UF_NOTE: { label: "Note", value: "x" } },
    })
    const cleared = await cli("deals", "update", ref, "--field", "note=")
    expect(Object.keys(cleared.item.deal as object)).toContain("provider_metadata")
    expect((cleared.item.deal as { provider_metadata: object }).provider_metadata).not.toHaveProperty("UF_NOTE")
  })

  it("an owner on a CRM copy is its assignee, as the CRM user's identity", async () => {
    const { cli, ref } = await synced()
    const done = await cli("deals", "update", ref, "--owner", "7")
    expect(done.item.deal).toMatchObject({ assignee: "portal/user/7" })
  })

  it("a CLI's own keys are checked by the write", async () => {
    const harness = await setup({}, { writes: WRITES, permissions: { "api.crm.deal.update": "deny" } })
    await harness.cli("sync")
    const ref = (await harness.cli("deals", "list", "status:open")).items[0]?.ref as string
    expect(crmAlsoChecks()(["deals", "move"])).toEqual([{ key: "deals.close", when: "a won or lost stage" }])
    expect(crmAlsoChecks()(["deals", "list"])).toEqual([])
    harness.alsoChecks.value = () => ["api.crm.deal.update"]
    await expect(harness.cli("deals", "update", ref, "--title", "Example")).rejects.toMatchObject({
      code: "permission_error",
    })
    expect(harness.source.writes).toEqual([])
  })

  it("a write the CRM made whose item could not be read back is journaled as sent, and the failure answered", async () => {
    const { cli, ref, source, journal } = await synced()
    source.failNextReadBack()
    await expect(cli("deals", "update", ref, "--title", "Example unread")).rejects.toMatchObject({
      code: "provider_error",
      details: { sent: true, operation_id: expect.any(String) },
    })
    expect(journal()).toEqual([expect.objectContaining({ outcome: "sent", key: "deals.update" })])
  })
})

describe("CRM stage tasks", () => {
  const NOW = Date.UTC(2026, 10, 11)
  const rules = async (path: string, value: Record<string, unknown>) => {
    const database = await openCache(path)
    saveCrmSetting(database, crmSettingKey(PORTAL, "stage-tasks"), value, NOW)
    database.close()
  }
  const tasksOf = async (store: MessageStore, ref: string) =>
    store.tasks.find({ where: { sql: "t.source_group = ?", params: [ref] } })
  const stageTasks = async (cli: (...args: string[]) => Promise<{ item: Record<string, unknown> }>) =>
    (await cli("sync")).item.stage_tasks
  const QUOTE = {
    quote: { title: "Send the quote", due_days: 2 },
    "lead:lead-good": { title: "Call back", due_days: 0 },
  }

  it("open one task per move into a configured stage, none on the first sync, for a new row or another stage", async () => {
    const { path, cli, source, store } = await setup({}, { now: () => NOW })
    await rules(path, QUOTE)
    expect(await stageTasks(cli)).toBe(0)
    const d1 = (await cli("deals", "list", "status:open")).items[0]?.ref as string
    const update = (stage: string) =>
      source.put("deal", exampleDeal("d1", { title: "Example website", organization: "c1", stage }))

    source.put(
      "deal",
      exampleDeal("d1", { title: "Example website", organization: "c1", stage: "quote", assignee: "7" }),
    )
    source.put("deal", exampleDeal("d2", { stage: "quote" }))
    source.put("deal", exampleDeal("d3", { stage: "quote" }))
    source.put("lead", exampleLead("l1", { stage: "lead-good" }))
    expect(await stageTasks(cli)).toBe(3)
    const {
      items: [task],
    } = await tasksOf(store, d1)
    expect(task).toMatchObject({
      title: "Send the quote",
      status: "open",
      dueAt: new Date(NOW + 2 * 86_400_000).toISOString(),
    })
    expect(task?.description).toContain("Example website")
    expect(task?.description).toContain("Quote sent")
    expect(task?.description).toContain("Responsible: CRM user 7")
    expect(await stageTasks(cli)).toBe(0)

    update("won")
    expect(await stageTasks(cli)).toBe(0)
    update("quote")
    expect(await stageTasks(cli)).toBe(1)
    expect((await tasksOf(store, d1)).items).toHaveLength(2)
    expect((await dealContext(store, d1)).tasks.items.map(({ title }) => title)).toEqual([
      "Send the quote",
      "Send the quote",
    ])
  })

  it("a dismissed task stays dismissed when its move is read again", async () => {
    const { path, cli, source, store } = await setup({}, { now: () => NOW })
    await rules(path, QUOTE)
    await cli("sync")
    source.put("deal", exampleDeal("d2", { stage: "quote" }))
    expect(await stageTasks(cli)).toBe(1)
    const ref = (await cli("deals", "list", "status:open")).items.find(({ external_id }) => external_id === "d2")
      ?.ref as string
    const {
      items: [task],
    } = await tasksOf(store, ref)
    await store.tasks.edit(task?.ref as string, { status: "dismissed" }, "owner")
    const database = await openCache(path)
    database.prepare("UPDATE store_settings SET value = '0' WHERE key LIKE '%.stage-tasks.after'").run()
    database.close()
    expect(await stageTasks(cli)).toBe(0)
    expect((await tasksOf(store, ref)).items.map(({ status }) => status)).toEqual(["dismissed"])
  })

  it("moves made before the rule was set open none, and a deals move counts at the next sync", async () => {
    const { path, cli, source, store } = await setup({}, { writes: WRITES, now: () => NOW })
    await cli("sync")
    const ref = (await cli("deals", "list", "status:open")).items[0]?.ref as string
    source.put("deal", exampleDeal("d1", { title: "Example website", organization: "c1", stage: "quote" }))
    await cli("sync")
    await cli("deals", "move", ref, "New")
    await rules(path, QUOTE)
    expect(await stageTasks(cli)).toBe(0)
    await cli("deals", "move", ref, "Quote sent")
    expect(await stageTasks(cli)).toBe(1)
    expect((await tasksOf(store, ref)).items).toHaveLength(1)
  })
})
