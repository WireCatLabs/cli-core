import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import * as v from "valibot"
import { expect, it } from "vitest"
import { openCache } from "../store/open.js"
import { saveOwnerLanguages } from "../store/sqlite/owner-languages.js"
import { openStore } from "../store/store.js"
import type { AccountKey } from "../store/types.js"
import { answerEntitySchema } from "./answer-entity.js"
import { baseStagesCommand } from "./base-stages-command.js"
import { commandsCommand } from "./commands-command.js"
import type { Body } from "./envelope.js"
import { run as runProgram } from "./program.js"
import { runsCommand } from "./runs/command.js"

const app = { command: "fixture", appName: "fixture", envPrefix: "FIXTURE", description: "synthetic", version: "1.0.0" }
const PORTAL = { provider: "example-crm", account: "portal-a" }
const OTHER = { provider: "example-crm", account: "portal-b" }

const fixture = async (accounts?: AccountKey[], env: NodeJS.ProcessEnv = {}) => {
  const path = join(mkdtempSync(join(tmpdir(), "base-stages-command-")), "store.db")
  const seeded = await openStore({ path })
  const database = await openCache(path)
  saveOwnerLanguages(database, ["en"], Date.now())
  database.close()
  for (const key of [PORTAL, OTHER])
    await seeded.crm.savePipelines(key, "deal", [
      {
        externalId: "p1",
        name: `Sales ${key.account}`,
        stages: [
          { externalId: "s1", name: "Inbox", position: 1, outcome: "open" },
          { externalId: "s2", name: "Paid", position: 2, outcome: "won" },
          { externalId: "s3", name: "Refused", position: 3, outcome: "lost" },
        ],
      },
    ])
  await seeded.close()
  const answers: Body[] = []
  const run = async (...words: string[]) => {
    const stages = baseStagesCommand(app, {
      env: () => env,
      open: () => openStore({ path }),
      output: (body) => answers.push(body),
      ...(accounts ? { accounts: async () => accounts } : {}),
    })
    await new Command("fixture")
      .exitOverride()
      .addCommand(stages)
      .parseAsync(["stages", ...words], { from: "user" })
    const body = answers.at(-1) as Body
    const leaf = words
      .slice(0, 1)
      .reduce<Command | undefined>((at, word) => at?.commands.find((one) => one.name() === word), stages)
    const schema = answerEntitySchema(leaf) as v.GenericSchema
    for (const item of "items" in body ? body.items : [body.item]) v.parse(schema, item)
    return body as Body & { item: Record<string, unknown>; items: Record<string, unknown>[] }
  }
  return { run }
}

it("shows, edits and maps the base set in the answers' declared shapes", async () => {
  const { run } = await fixture()
  const shown = await run("show", "deal")
  expect(shown.item).toMatchObject({ kind: "deal", unsorted: { open: 0, stages: 6 } })
  const added = await run("create", "deal", "Demo")
  expect((added.item.stages as { name: string }[]).map(({ name }) => name)).toEqual([
    "New",
    "Qualification",
    "Proposal",
    "Negotiation",
    "Demo",
    "Won",
    "Lost",
  ])
  expect((await run("create", "deal", "Paused", "lost")).item.stages).toContainEqual(
    expect.objectContaining({ name: "Paused", outcome: "lost", position: 8 }),
  )
  await run("rename", "deal", "Demo", "Presentation")
  await run("move", "deal", "Presentation", "3")
  await run("remove", "deal", "Presentation")
  await run("remove", "deal", "Paused")

  const listed = await run("list", "confirmed:false")
  expect(listed.items).toHaveLength(6)
  expect(listed.items[0]).toMatchObject({
    name: "Inbox",
    base_stage: { name: "New" },
    confirmed: false,
    untrusted: ["name", "pipeline_name"],
  })
  const set = await run("set", listed.items[0]?.ref as string, "Proposal")
  expect(set.item).toMatchObject({ base_stage: { name: "Proposal" }, confirmed: true })
  expect((await run("confirm", "--pipeline", listed.items[0]?.pipeline as string)).item).toEqual({
    confirmed: 2,
  })
  expect((await run("confirm", "--all")).item).toEqual({ confirmed: 3 })
  await expect(run("confirm")).rejects.toMatchObject({ code: "validation_error" })
})

it("reads and confirms only the accounts the host puts in scope", async () => {
  const { run } = await fixture([PORTAL])
  expect((await run("list")).items.map(({ account }) => account)).toEqual([PORTAL, PORTAL, PORTAL])
  expect((await run("confirm", "--all")).item).toEqual({ confirmed: 3 })
  expect((await run("show", "deal")).item).toMatchObject({ unsorted: { open: 0, stages: 0 } })
})

it("lets an agent suggest a mapping, and keeps confirming and editing the set to the owner", async () => {
  const { run } = await fixture(undefined, { AI_AGENT: "codex" })
  const [inbox] = (await run("list")).items
  expect((await run("set", inbox?.ref as string, "Proposal")).item).toMatchObject({
    base_stage: { name: "Proposal" },
    confirmed: false,
  })
  for (const words of [
    ["confirm", "--all"],
    ["create", "deal", "Demo"],
    ["rename", "deal", "New", "Fresh"],
  ])
    await expect(run(...words)).rejects.toMatchObject({
      code: "permission_error",
      details: { reason: "stage.owner-only" },
    })
})

it("passes the command lint memo runs on its tree", async () => {
  const definition = {
    app,
    commands: () => [
      commandsCommand(app),
      runsCommand(app),
      baseStagesCommand(app, {
        env: () => ({}),
        open: () => Promise.reject(new Error("not opened")),
        output: () => {},
      }),
    ],
  }
  const streams = captureStreams()
  expect(await runProgram(["commands", "--json"], definition, { streams, tty: false, env: {} })).toBe(0)
  const folder = mkdtempSync(join(tmpdir(), "base-stages-lint-"))
  const document = join(folder, "commands.json")
  writeFileSync(document, streams.stdout.join(""))
  const lint = spawnSync(join(process.cwd(), "node_modules/.bin/cli-dev"), ["lint", "--commands", document], {
    cwd: folder,
    encoding: "utf8",
  })
  const rules = [...`${lint.stdout}${lint.stderr}`.matchAll(/^(?:high|medium|low)\s+(\S+.*)$/gmu)].map(
    ([, rule]) => rule,
  )
  expect(rules).toEqual([])
})
