import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { memoryKeyring } from "@wirecat/cli-base"
import { Command } from "commander"
import * as v from "valibot"
import { expect, it, vi } from "vitest"
import type { CrmPipeline } from "../domain/crm.js"
import { aiSettingPath, writeAiSetting } from "../models/ai.js"
import { openCache } from "../store/open.js"
import { saveOwnerLanguages } from "../store/sqlite/owner-languages.js"
import { openStore } from "../store/store.js"
import { answerEntitySchema } from "./answer-entity.js"
import { baseStagesCommand } from "./base-stages-command.js"
import type { Body } from "./envelope.js"

const app = { command: "fixture", appName: "fixture", envPrefix: "FIXTURE", description: "synthetic", version: "1.0.0" }
const PORTAL = { provider: "example-crm", account: "portal-a" }

const SALES: CrmPipeline = {
  externalId: "p1",
  name: "Sales",
  stages: [
    { externalId: "s1", name: "Inbox", position: 1, outcome: "open" },
    { externalId: "s2", name: "Price sent", position: 2, outcome: "open" },
    { externalId: "s3", name: "Bargaining", position: 3, outcome: "open" },
    { externalId: "s4", name: "Paid", position: 4, outcome: "won" },
    { externalId: "s5", name: "Refused", position: 5, outcome: "lost" },
  ],
}

const chat = (text: string) =>
  new Response(
    JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { total_tokens: 7 } }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  )

const fixture = async (extra: NodeJS.ProcessEnv = {}) => {
  const root = mkdtempSync(join(tmpdir(), "stages-suggest-"))
  const env: NodeJS.ProcessEnv = {
    WIRECAT_STATE_DIR: root,
    WIRECAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "store.db"),
    ...extra,
  }
  const path = env.MESSAGING_STORE as string
  const seeded = await openStore({ path })
  const database = await openCache(path)
  saveOwnerLanguages(database, ["en"], Date.now())
  database.close()
  await seeded.crm.savePipelines(PORTAL, "deal", [SALES])
  await seeded.close()
  const fetch = vi.fn(async (_input: unknown, _init?: RequestInit) => chat(""))
  const answers: Body[] = []
  let piped = ""
  const run = async (stdin: string, ...words: string[]) => {
    piped = stdin
    const stages = baseStagesCommand(app, {
      env: () => env,
      open: () => openStore({ path }),
      output: (body) => answers.push(body),
      keyring: memoryKeyring(),
      fetch,
      stdin: () => Readable.from([piped]),
    })
    await new Command("fixture")
      .exitOverride()
      .addCommand(stages)
      .parseAsync(["stages", ...words], { from: "user" })
    const body = answers.at(-1) as Body & { item: Record<string, unknown> }
    const leaf = stages.commands.find((one) => one.name() === words[0])
    v.parse(answerEntitySchema(leaf) as v.GenericSchema, body.item)
    return body.item
  }
  const mapped = async () => {
    const store = await openStore({ path })
    try {
      return Object.fromEntries(
        (await store.baseStages.mappings()).map((row) => [
          row.name,
          `${row.baseStage?.name ?? "-"}${row.confirmed ? "" : "?"}`,
        ]),
      )
    } finally {
      await store.close()
    }
  }
  const sync = async () => {
    const store = await openStore({ path })
    await store.crm.savePipelines(PORTAL, "deal", [SALES])
    await store.close()
  }
  return { env, run, fetch, mapped, sync, root }
}

const refs = async (run: Awaited<ReturnType<typeof fixture>>["run"]) => {
  const job = (await run("", "suggest", "--dry-run")) as {
    stages: { ref: string; name: string }[]
    base_stages: { ref: string; name: string }[]
  }
  const of = (list: { ref: string; name: string }[], name: string) => list.find((one) => one.name === name)?.ref
  return { job, stage: (name: string) => of(job.stages, name), base: (name: string) => of(job.base_stages, name) }
}

it("asks only about stages with a choice, and refuses to call a model before one is chosen", async () => {
  const { run, fetch } = await fixture()
  const { job } = await refs(run)
  expect(job.stages.map(({ name }) => name)).toEqual(["Inbox", "Price sent", "Bargaining"])
  expect(job).toMatchObject({ submit: "fixture stages suggest --text-file -", untrusted: ["stages"] })
  expect(job.stages[1]).toMatchObject({ kind: "deal", outcome: "open", position: 2, pipeline_name: "Sales" })
  await expect(run("", "suggest")).rejects.toMatchObject({
    code: "configuration_error",
    message: expect.stringContaining("fixture models ai set"),
    details: { reason: "ai.not-set" },
  })
  expect(fetch).not.toHaveBeenCalled()
})

it("records the model's answers as suggestions a later sync keeps, and skips what it was not asked", async () => {
  const { env, run, fetch, mapped, sync } = await fixture()
  writeAiSetting(aiSettingPath(env), { provider: "ollama", model: "llama3.2" })
  const { stage, base } = await refs(run)
  fetch.mockResolvedValueOnce(
    chat(
      JSON.stringify({
        map: [
          { stage: stage("Price sent"), base: base("Proposal") },
          { stage: stage("Bargaining"), base: base("Negotiation") },
          { stage: stage("Bargaining"), base: base("New") },
          { stage: stage("Inbox"), base: base("Won") },
          { stage: "stage:999", base: base("New") },
        ],
      }),
    ),
  )
  expect(await run("", "suggest")).toEqual({
    by: "ollama/llama3.2",
    suggested: 2,
    left: 1,
    skipped: [
      { stage: stage("Bargaining"), base: base("New"), why: "repeated" },
      { stage: stage("Inbox"), base: base("Won"), why: "base-not-allowed" },
      { stage: "stage:999", base: base("New"), why: "not-asked" },
    ],
  })
  const sent = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as { messages: { content: string }[] }
  expect(sent.messages.at(-1)?.content).toContain('"name":"Price sent"')

  await sync()
  expect(await mapped()).toEqual({
    Inbox: "New?",
    "Price sent": "Proposal?",
    Bargaining: "Negotiation?",
    Paid: "Won?",
    Refused: "Lost?",
  })
})

it("takes an agent's answer from stdin, and keeps the paid model call to the owner", async () => {
  const { env, run, fetch, mapped } = await fixture({ AI_AGENT: "codex" })
  writeAiSetting(aiSettingPath(env), { provider: "ollama", model: "llama3.2" })
  const { stage, base } = await refs(run)
  await expect(run("", "suggest")).rejects.toMatchObject({ details: { reason: "stage.model-agent" } })
  expect(fetch).not.toHaveBeenCalled()

  const answer = JSON.stringify({ map: [{ stage: stage("Inbox"), base: base("Qualification") }] })
  expect(await run(answer, "suggest", "--text-file", "-")).toMatchObject({ by: "agent", suggested: 1, left: 2 })
  expect((await mapped()).Inbox).toBe("Qualification?")
  await expect(run("not json", "suggest", "--text-file", "-")).rejects.toMatchObject({
    details: { reason: "stage.answer-invalid" },
  })
})

it("reads an agent's answer from a file", async () => {
  const { run, root, mapped } = await fixture()
  const { stage, base } = await refs(run)
  const file = join(root, "answer.json")
  writeFileSync(file, JSON.stringify({ map: [{ stage: stage("Bargaining"), base: base("Proposal") }] }))
  expect(await run("", "suggest", "--text-file", file)).toMatchObject({ by: "agent", suggested: 1 })
  expect((await mapped()).Bargaining).toBe("Proposal?")
})
