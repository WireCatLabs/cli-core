import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describeProgram } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { provide } from "../../cli/context.js"
import { unknownPermissionIssues } from "../../cli/permission-keys.js"
import { toolsFromCommands } from "../../mcp/agent.js"
import type { AppIdentity } from "../../ports/app.js"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import type { Level } from "../../sends/permissions.js"
import { type MessageStore, openStore } from "../../store/store.js"
import { exampleTrackerRows, fakeTrackerSource } from "../testing/index.js"
import { TRACKER_WRITES, trackerAlsoChecks } from "../writer.js"
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

const setup = async (permissions: Record<string, Level> = {}, rows = exampleTrackerRows()) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "tracker-writes-")), "store.db") })
  opened.push(store)
  const source = fakeTrackerSource({ rows, self: "user-1" })
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
    expect(tools.find(({ command }) => command === "issues comments create")?.writes).toBe(true)
    expect(trackerAlsoChecks(() => ["api.issue-create"])(["issues", "create"])).toEqual([
      { key: "issues.assign-others", when: "--assignee other than the sign-in's user" },
      "api.issue-create",
    ])
    const api = (write: string) => [`api.${write}`]
    expect(trackerAlsoChecks(api)(["issues", "comments", "create"])).toEqual(["api.comment"])
    expect(trackerAlsoChecks(api)(["issues", "comment"])).toEqual([])
  })

  it("create resolves names in the copy, writes once, journals it and stores the tracker's answer", async () => {
    const { cli, source, journal } = await setup({ "issues.assign-others": "allow" })
    const made = await cli(
      "issues",
      "create",
      "--title",
      "Example: refunds round down",
      "--team",
      "eng",
      "--status",
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
      priority_label: "high",
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
    const done = await cli(
      "issues",
      "update",
      "eng-2",
      "--status",
      "In Progress",
      "--assignee",
      "",
      "--label",
      "",
      "--priority",
      "",
    )
    expect(done.item.issue).toMatchObject({
      key: "ENG-2",
      title: "Write the migration guide",
      state: "state-doing",
      assignee: null,
      labels: [],
      priority: 0,
      priority_label: null,
      project: "project-1",
    })
    expect((await cli("issues", "list", "type:started")).items.map((one) => one.key)).toContain("ENG-2")
  })

  it("--priority takes the family's priority and writes the tracker's 0 none, 1 urgent … 4 low", async () => {
    const { cli } = await setup()
    const typed = async (value: string) =>
      ((await cli("issues", "update", "ENG-1", "--priority", value)).item.issue as Record<string, unknown>).priority
    expect(await typed("critical")).toBe(1)
    expect(await typed("urgent")).toBe(1)
    expect(await typed("medium")).toBe(3)
    expect(await typed("0.1")).toBe(4)
    expect(await typed("0")).toBe(1)
    expect(await typed("none")).toBe(0)
    const shown = (await cli("issues", "list", "--limit", "500")).items.find((one) => one.key === "ENG-1")
    expect(shown).toMatchObject({ priority: 0, priority_label: null })
  })

  it("comments create adds the owner's text to the issue, and issues show lists it", async () => {
    const { cli } = await setup()
    const done = await cli("issues", "comments", "create", "ENG-1", "--text", "Example: fixed in the next release")
    expect(done.item.comment).toMatchObject({ issue: "issue-1", body: "Example: fixed in the next release" })
    expect(done.item.untrusted).toContain("comment.body")
    const shown = (await cli("issues", "show", "ENG-1")).item.comments as Record<string, unknown>[]
    expect(shown.map((one) => one.body)).toContain("Example: fixed in the next release")
  })

  it("refuses what the copy cannot resolve before anything is sent", async () => {
    const { cli, source, store } = await setup()
    await expect(cli("issues", "create", "--title", "X", "--status", "Shipped")).rejects.toMatchObject({
      details: { reason: "tracker.reference", param: "--status" },
    })
    await expect(cli("issues", "update", "ENG-404", "--title", "X")).rejects.toMatchObject({ code: "not_found" })
    await expect(cli("issues", "update", "ENG-1")).rejects.toMatchObject({ code: "validation_error" })
    await expect(cli("issues", "update", "ENG-1", "--parent", "ENG-1")).rejects.toMatchObject({
      details: { param: "--parent" },
    })
    await expect(cli("issues", "comments", "create", "ENG-1", "--text", " ")).rejects.toMatchObject({
      code: "validation_error",
    })
    await expect(cli("issues", "update", "ENG-1", "--priority", "soon")).rejects.toMatchObject({
      details: { param: "--priority" },
    })
    await store.tracker.save(ACCOUNT, "team", [{ externalId: "team-2", key: "OPS", name: "Operations" }], 1)
    await expect(cli("issues", "create", "--title", "X")).rejects.toMatchObject({
      details: { reason: "tracker.team-required", allowed: expect.arrayContaining(["team-1", "team-2"]) },
    })
    expect(source.sent).toEqual([])
  })

  it("an issue goes to someone else only when the profile allows issues.assign-others", async () => {
    const { cli, source } = await setup()
    await expect(cli("issues", "update", "ENG-1", "--assignee", "Bob Builder")).rejects.toMatchObject({
      code: "permission_error",
    })
    await expect(cli("issues", "create", "--title", "X", "--assignee", "user-2")).rejects.toMatchObject({
      code: "permission_error",
    })
    expect(source.sent).toEqual([])
    await cli("issues", "update", "ENG-2", "--assignee", "ada@example.com")
    await cli("issues", "update", "ENG-2", "--assignee", "")
    expect(source.sent).toHaveLength(2)
    const lifted = await setup({ "issues.assign-others": "allow" })
    expect((await lifted.cli("issues", "update", "ENG-1", "--assignee", "user-2")).item.issue).toMatchObject({
      assignee: "user-2",
    })
  })

  it("a label is looked for among the issue's team's and the workspace's, every row of them", async () => {
    const rows = exampleTrackerRows()
    rows.team.push({ externalId: "team-2", key: "OPS", name: "Operations" })
    rows.label.push(
      { externalId: "label-ops-bug", name: "Bug", team: "team-2" },
      { externalId: "label-urgent", name: "Urgent", team: null },
    )
    const { cli, store } = await setup({}, rows)
    const done = await cli("issues", "update", "ENG-1", "--label", "bug", "--label", "Urgent")
    expect(done.item.issue).toMatchObject({ labels: ["label-bug", "label-urgent"] })
    const moved = await cli("issues", "update", "ENG-2", "--team", "OPS", "--label", "Bug")
    expect(moved.item.issue).toMatchObject({ team: "team-2", labels: ["label-ops-bug"] })
    // Past one page of the store's list: a uniqueness check over a capped page would miss the second match.
    const many = Array.from({ length: 520 }, (_, n) => ({ externalId: `l-${n}`, name: `Chore ${n}`, team: null }))
    const twins = [1, 2].map((n) => ({ externalId: `twin-${n}`, name: "Twin", team: null, updatedAt: n }))
    await store.tracker.save(ACCOUNT, "label", [...twins, ...many.map((one) => ({ ...one, updatedAt: 10_000 }))], 1)
    await expect(cli("issues", "update", "ENG-1", "--label", "Twin")).rejects.toMatchObject({
      details: { reason: "tracker.reference", candidates: [expect.anything(), expect.anything()] },
    })
  })

  it("a label made after the last sync is asked of the tracker once and kept in the copy; an unknown one is refused", async () => {
    const rows = exampleTrackerRows()
    const { cli, source } = await setup({}, rows)
    const asked: string[] = []
    const changes = source.changes.bind(source)
    source.changes = (kind, cursor, page, context) => {
      asked.push(kind)
      return changes(kind, cursor, page, context)
    }
    const later = Date.UTC(2026, 10, 18)
    rows.label.push(
      { externalId: "label-new", name: "Regression", team: "team-1", updatedAt: later },
      { externalId: "label-two", name: "Flaky", team: null, updatedAt: later },
    )
    const done = await cli("issues", "create", "--title", "X", "--label", "regression", "--label", "flaky")
    expect(done.item.issue).toMatchObject({ labels: ["label-new", "label-two"] })
    expect(asked).toEqual(["label"])
    const listed = (await cli("issues", "list", "label:Regression")).items.map((one) => one.external_id)
    expect(listed).toEqual([(done.item.issue as { external_id: string }).external_id])
    await expect(cli("issues", "create", "--title", "Y", "--label", "Regresion")).rejects.toMatchObject({
      message: expect.stringMatching(/no label Regresion .*close names: Regression; nor among the labels changed/),
      details: {
        reason: "tracker.reference",
        param: "--label",
        candidates: [{ id: "label-new", name: "Regression", team: "team-1" }],
      },
    })
    expect(source.sent).toHaveLength(1)
  })

  it("a label the tracker deleted since the last sync is never taken from its changes", async () => {
    const rows = exampleTrackerRows()
    const { cli, source } = await setup({}, rows)
    rows.label.push({
      externalId: "label-gone",
      name: "Gone",
      team: null,
      updatedAt: Date.UTC(2026, 10, 18),
      deleted: true,
    })
    await expect(cli("issues", "create", "--title", "X", "--label", "Gone")).rejects.toThrow(
      /no label Gone .*nor among the labels changed since the last sync/,
    )
    expect(source.sent).toEqual([])
  })

  it("a name the copy lacks before any sync is refused with the hint to run sync", async () => {
    const { cli, store } = await setup()
    await store.sync.setSyncState(
      ACCOUNT,
      "tracker:label",
      JSON.stringify({ v: 1, token: null, round: null, passAt: 0 }),
    )
    await expect(cli("issues", "create", "--title", "X", "--label", "Nope")).rejects.toThrow(
      /no label Nope in the copy.*not in the copy; run sync, then try again/,
    )
  })

  it("a new issue is refused when the copy holds no team", async () => {
    const { cli, source } = await setup({}, { ...exampleTrackerRows(), team: [] })
    await expect(cli("issues", "create", "--title", "X")).rejects.toMatchObject({
      details: { reason: "tracker.team-required", param: "--team" },
    })
    expect(source.sent).toEqual([])
  })

  it("a saved issues.comment, the key before comments create, is refused and names the new key", async () => {
    const { program } = await setup()
    const settings = {
      configPath: "/config.toml",
      profile: "work",
      permissions: { "issues.comment": "allow" as const },
      permissionSources: {},
    }
    const [issue] = unknownPermissionIssues(program(), settings, "tracker")
    expect(JSON.stringify(issue)).toContain("issues.comments.create")
  })

  it("--dry-run previews a write and sends nothing", async () => {
    const { cli, source } = await setup()
    const previewed = await cli("issues", "comments", "create", "ENG-1", "--text", "x", "--dry-run")
    expect(previewed.item).toMatchObject({ preview: true })
    expect(source.sent).toEqual([])
  })

  it("a denied key stops the write; at ask it needs the owner's yes, asked once", async () => {
    const denied = await setup({ "issues.create": "deny" })
    await expect(denied.cli("issues", "create", "--title", "X")).rejects.toMatchObject({ code: "permission_error" })
    expect(denied.source.sent).toEqual([])
    const asked = await setup({ "issues.comments.create": "ask" })
    await expect(asked.cli("issues", "comments", "create", "ENG-1", "--text", "x")).rejects.toMatchObject({
      code: "confirmation_required",
    })
    expect(asked.source.sent).toEqual([])
    await asked.cli("issues", "comments", "create", "ENG-1", "--text", "x", "--yes")
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
