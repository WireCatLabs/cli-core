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
import { type MessageStore, openStore } from "../../store/store.js"
import { exampleDeal, exampleLead, exampleOrganization, examplePerson, fakeCrmSource } from "../testing/index.js"
import { addCrmCommands, type CrmRun } from "./index.js"

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

const setup = async (extra: Partial<CrmRun> = {}) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "crm-cli-")), "store.db") })
  opened.push(store)
  await store.accounts.registerProvider({
    name: "example-crm",
    kind: "crm",
    aliases: [],
    command: "crm",
    opens: CRM_OPENS,
  })
  const source = fakeCrmSource()
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
  const runOf: CrmRun = { profile: "work", account: PORTAL, store, source: () => source, ...extra }
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
    addCrmCommands(root, { app: APP, open: async () => runOf })
    provide(root, {
      streams: { data: (text: string) => (data += text), diagnostic: () => undefined },
      tty: false,
    } as never)
    data = ""
    await root.parseAsync([...args, "--json"], { from: "user" })
    const envelope = JSON.parse(data) as Record<string, unknown> & { item?: unknown; items?: unknown[] }
    const schema = answerEntitySchema(commandAt(root, args))
    if (!schema) throw new Error(`${args.join(" ")} declares no answer entity`)
    for (const item of envelope.items ?? [envelope.item]) {
      const parsed = v.safeParse(schema, item)
      if (!parsed.success)
        throw new Error(
          `${args.join(" ")}: ${parsed.issues.map((one) => `${v.getDotPath(one)} ${one.message}`).join("; ")}`,
        )
    }
    return envelope as Record<string, unknown> & { item: Record<string, unknown>; items: Record<string, unknown>[] }
  }
  return { store, source, cli }
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
        addCrmCommands(root, { app: APP, open: () => Promise.reject(new Error("not opened")) })
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
