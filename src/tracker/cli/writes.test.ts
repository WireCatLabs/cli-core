import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describeProgram } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { provide } from "../../cli/context.js"
import { toolsFromCommands } from "../../mcp/agent.js"
import type { AppIdentity } from "../../ports/app.js"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import type { Level } from "../../sends/permissions.js"
import { type MessageStore, openStore } from "../../store/store.js"
import { exampleTrackerRows, fakeTrackerSource } from "../testing/index.js"
import { TRACKER_WRITES } from "../writer.js"
import { addTrackerCommands } from "./index.js"

const APP: AppIdentity = {
  command: "tracker",
  appName: "example-tracker-cli",
  envPrefix: "TRACKER",
  description: "synthetic",
  version: "1.0.0",
}
const ACCOUNT = { provider: "fake-tracker", account: "workspace" }

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

type Answer = Record<string, unknown> & { items: Record<string, unknown>[]; item: Record<string, unknown> }

const setup = async (permissions: Record<string, Level> = {}) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "tracker-writes-")), "store.db") })
  opened.push(store)
  const source = fakeTrackerSource({ rows: exampleTrackerRows(), self: "user-1" })
  const home = mkdtempSync(join(tmpdir(), "tracker-journal-"))
  const env = { HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, TRACKER_STATE_DIR: home }
  const writes = () => ({
    writer: source,
    app: APP,
    env,
    settings: () => ({ profile: "work", permissions, permissionSources: {}, sendsPerHour: 0 }),
  })
  const program = (mounted = true) => {
    const root = new Command("tracker")
      .exitOverride()
      .configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
      .option("--json")
      .option("--yes")
      .option("--dry-run")
    addTrackerCommands(root, {
      app: APP,
      open: async () => ({ account: ACCOUNT, store, source: () => source, writes }),
      ...(mounted ? { writes: TRACKER_WRITES } : {}),
    })
    return root
  }
  const cli = async (...args: string[]): Promise<Answer> => {
    let data = ""
    const root = program()
    provide(root, { streams: { data: (text: string) => (data += text), diagnostic: () => {} } } as never)
    await root.parseAsync([...args, "--json"], { from: "user" })
    return JSON.parse(data) as Answer
  }
  await cli("sync")
  const journal = () => new SendJournal(sendsPathFor(APP, "work", env)).entries()
  return { cli, store, source, journal, program }
}

describe("tracker write commands", () => {
  it("exist only when the CLI passes the writes, and are MCP writes that take a list of labels", async () => {
    const { program } = await setup()
    const names = (root: Command) =>
      root.commands.find((one) => one.name() === "issues")?.commands.map((one) => one.name())
    expect(names(program(false))).toEqual(["list", "show", "search", "assign"])
    const tools = toolsFromCommands(describeProgram(program()))
    const create = tools.find(({ command }) => command === "issues create")
    expect(create?.writes).toBe(true)
    expect(JSON.stringify(create?.input.entries.label)).toContain("array")
    expect(tools.find(({ command }) => command === "issues comment")?.writes).toBe(true)
  })

  it("create resolves names in the copy, writes once, journals it and stores the tracker's answer", async () => {
    const { cli, source, journal } = await setup()
    const made = await cli(
      "issues",
      "create",
      "--title",
      "Example: refunds round down",
      "--team",
      "eng",
      "--state",
      "todo",
      "--assignee",
      "bob@example.com",
      "--label",
      "Bug",
      "--priority",
      "high",
      "--project",
      "Billing revamp",
    )
    const issue = made.item.issue as Record<string, unknown>
    expect(issue).toMatchObject({
      key: "ENG-4",
      title: "Example: refunds round down",
      team: "team-1",
      state: "state-todo",
      state_name: "Todo",
      assignee: "user-2",
      assignee_name: "Bob Builder",
      labels: ["label-bug"],
      priority: 2,
      project: "project-1",
    })
    expect(made.item.untrusted).toContain("issue.title")
    expect(source.sent).toEqual([{ write: "create", id: "issue-4" }])
    expect(journal()).toEqual([
      expect.objectContaining({ outcome: "sent", key: "issues.create", operationId: made.item.operation_id }),
    ])
    expect((await cli("issues", "show", "ENG-4")).item).toMatchObject({ title: "Example: refunds round down" })
  })

  it("update changes only what it names; an empty value clears; the copy has the change at once", async () => {
    const { cli } = await setup()
    const done = await cli("issues", "update", "eng-2", "--state", "In Progress", "--assignee", "", "--label", "")
    expect(done.item.issue).toMatchObject({
      key: "ENG-2",
      title: "Write the migration guide",
      state: "state-doing",
      assignee: null,
      labels: [],
      project: "project-1",
    })
    expect((await cli("issues", "list", "type:started")).items.map((one) => one.key)).toContain("ENG-2")
  })

  it("comment adds the owner's text to the issue, and issues show lists it", async () => {
    const { cli } = await setup()
    const done = await cli("issues", "comment", "ENG-1", "--body", "Example: fixed in the next release")
    expect(done.item.comment).toMatchObject({ issue: "issue-1", body: "Example: fixed in the next release" })
    expect(done.item.untrusted).toContain("comment.body")
    const shown = (await cli("issues", "show", "ENG-1")).item.comments as Record<string, unknown>[]
    expect(shown.map((one) => one.body)).toContain("Example: fixed in the next release")
  })

  it("refuses what the copy cannot resolve before anything is sent", async () => {
    const { cli, source, store } = await setup()
    await expect(cli("issues", "create", "--title", "X", "--state", "Shipped")).rejects.toMatchObject({
      details: { reason: "tracker.reference", param: "--state" },
    })
    await expect(cli("issues", "update", "ENG-404", "--title", "X")).rejects.toMatchObject({ code: "not_found" })
    await expect(cli("issues", "update", "ENG-1")).rejects.toMatchObject({ code: "validation_error" })
    await expect(cli("issues", "update", "ENG-1", "--parent", "ENG-1")).rejects.toMatchObject({
      details: { param: "--parent" },
    })
    await expect(cli("issues", "comment", "ENG-1", "--body", " ")).rejects.toMatchObject({ code: "validation_error" })
    await store.tracker.save(ACCOUNT, "team", [{ externalId: "team-2", key: "OPS", name: "Operations" }], 1)
    await expect(cli("issues", "create", "--title", "X")).rejects.toMatchObject({
      details: { reason: "tracker.team-required", allowed: expect.arrayContaining(["team-1", "team-2"]) },
    })
    expect(source.sent).toEqual([])
  })

  it("--dry-run previews a write and sends nothing", async () => {
    const { cli, source } = await setup()
    expect((await cli("issues", "comment", "ENG-1", "--body", "x", "--dry-run")).item).toMatchObject({ preview: true })
    expect(source.sent).toEqual([])
  })

  it("a denied key stops the write; at ask it needs the owner's yes, asked once", async () => {
    const denied = await setup({ "issues.create": "deny" })
    await expect(denied.cli("issues", "create", "--title", "X")).rejects.toMatchObject({ code: "permission_error" })
    expect(denied.source.sent).toEqual([])
    const asked = await setup({ "issues.comment": "ask" })
    await expect(asked.cli("issues", "comment", "ENG-1", "--body", "x")).rejects.toMatchObject({
      code: "confirmation_required",
    })
    expect(asked.source.sent).toEqual([])
    await asked.cli("issues", "comment", "ENG-1", "--body", "x", "--yes")
    expect(asked.source.sent).toHaveLength(1)
    const readonly = await setup({ issues: "readonly" })
    await expect(readonly.cli("issues", "update", "ENG-1", "--title", "X")).rejects.toMatchObject({
      code: "permission_error",
    })
  })

  it("a lost answer is outcome_unknown, journaled, and sent once", async () => {
    const { cli, source, journal } = await setup()
    source.loseNextAnswer()
    await expect(cli("issues", "update", "ENG-1", "--title", "Example lost")).rejects.toMatchObject({
      code: "outcome_unknown",
      message: expect.stringContaining("sync and look"),
      details: { operation_id: expect.any(String) },
    })
    expect(source.sent).toHaveLength(1)
    expect(journal()).toEqual([expect.objectContaining({ outcome: "outcome_unknown", key: "issues.update" })])
  })
})
