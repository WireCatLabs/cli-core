import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { baseContext } from "../../cli/context.js"
import { commandPermissions } from "../../cli/permission-keys.js"
import { run } from "../../cli/program.js"
import { serviceApiCommand, serviceApiPermissions, serviceApiWriter } from "../../cli/service-api.js"
import { serviceApiCall } from "../../cli/service-api-call.js"
import { settingsFor } from "../../cli/settings.js"
import { FAKE_MANIFEST_TOKEN } from "../../crm/testing/index.js"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import { type MessageStore, openStore } from "../../store/store.js"
import { api, definitions, MANIFEST } from "../../testing/tracker-graphql.js"
import { addTrackerCommands } from "../cli/index.js"
import { trackerManifestFake, trackerManifestWriteContract, trackerManifestWriteFixture } from "../testing/index.js"
import { TRACKER_WRITES } from "../writer.js"
import { parseTrackerManifest, type TrackerManifest } from "./manifest.js"
import { trackerSourceFromManifest } from "./source.js"
import { trackerWriterFromManifest } from "./writer.js"

type Row = Record<string, unknown>
const writes = MANIFEST.writes as NonNullable<TrackerManifest["writes"]>
const issueWrites = writes.issue as NonNullable<typeof writes.issue>
const withWrites = (change: Row) => ({ ...MANIFEST, writes: { ...writes, ...change } })
const withIssueWrites = (change: Row) => withWrites({ issue: { ...issueWrites, ...change } })

describe("trackerManifestWriteContract over a Linear-shaped GraphQL schema", () => {
  for (const { name, run: check } of trackerManifestWriteContract(MANIFEST, { api, definitions })) it(name, check)
})

describe("parseTrackerManifest's writes", () => {
  const refused = (manifest: unknown, message: RegExp) =>
    expect(() => parseTrackerManifest(manifest, api)).toThrow(message)

  it("refuses a write that reads, lacks its slots, names no such field, or reads a field it does not select", () => {
    const create = issueWrites.create as NonNullable<typeof issueWrites.create>
    refused(
      withIssueWrites({ create: { ...create, operation: "issues" } }),
      /writes\.issue\.create\.operation: issues is a read/,
    )
    refused(withIssueWrites({ create: { ...create, operation: "issueCreat" } }), /did you mean issueCreate/)
    refused(withIssueWrites({ create: { ...create, variables: { input: {} } } }), /no "\{values\}"/)
    refused(
      withIssueWrites({ create: { ...create, variables: { input: "{values}", id: "{id}" } } }),
      /a create has no "\{id\}" yet/,
    )
    refused(
      withIssueWrites({ create: { ...create, variables: { input: "{values}", at: "{since}" } } }),
      /"\{since\}" is for a change read/,
    )
    refused(
      withIssueWrites({ update: { ...issueWrites.update, variables: { input: "{values}" } } }),
      /writes\.issue\.update: no "\{id\}"/,
    )
    refused(
      withIssueWrites({ fields: { ...issueWrites.fields, asignee: { to: "assigneeId" } } }),
      /did you mean assignee/,
    )
    refused(
      withIssueWrites({ create: { ...create, selection: "success issue { id title }" } }),
      /writes\.issue\.create\.selection: map\.\w+ reads \w+, which the selection leaves out/,
    )
    const { title: _, ...untitled } = issueWrites.fields
    refused(withIssueWrites({ fields: untitled }), /a new issue needs its title/)
    const comment = writes.comment as NonNullable<typeof writes.comment>
    refused(withWrites({ comment: { ...comment, update: issueWrites.update } }), /a comment is only added/)
    refused(withWrites({ comment: { ...comment, fields: { issue: { to: "issueId" } } } }), /needs its body/)
    expect(() => parseTrackerManifest(MANIFEST, api)).not.toThrow()
  })
})

describe("the fake's writes", () => {
  it("refuses a field the input type lacks and a missing required one, as the tracker would", async () => {
    const wrong = trackerManifestWriteFixture(
      withIssueWrites({ fields: { ...issueWrites.fields, state: { to: "statusId" } } }),
      { api, definitions },
    )
    await expect(
      wrong.writer.createIssue({ title: "X", team: wrong.team, state: wrong.state }, { operationId: "op-1" }),
    ).rejects.toThrow()
    expect(wrong.fake.refusals).toContainEqual(expect.stringContaining("statusId: no such field"))
    const teamless = trackerManifestWriteFixture(MANIFEST, { api, definitions })
    await expect(teamless.writer.createIssue({ title: "X" }, { operationId: "op-2" })).rejects.toThrow()
    expect(teamless.fake.refusals).toContainEqual(expect.stringContaining("teamId: required"))
  })

  it("answers an update of an issue it does not hold with the tracker's own error, not a refusal", async () => {
    const { writer, fake } = trackerManifestWriteFixture(MANIFEST, { api, definitions })
    await expect(writer.updateIssue("issue-404", { title: "X" }, { operationId: "op-1" })).rejects.toThrow()
    expect(fake.refusals).toEqual([])
  })

  it("is refused by the writer, before anything is sent, for a field the manifest does not write", async () => {
    const { priority: _, ...fields } = issueWrites.fields
    const { writer, fake } = trackerManifestWriteFixture(withIssueWrites({ fields }), { api, definitions })
    await expect(writer.updateIssue("issue-1", { priority: 1 }, { operationId: "op-1" })).rejects.toMatchObject({
      details: { reason: "tracker.write-unsupported", sent: false },
    })
    expect(fake.calls).toEqual([])
  })
})

const APP = {
  command: "tracker",
  appName: "example-tracker-cli",
  envPrefix: "TRACKER",
  description: "synthetic",
  version: "1.0.0",
  messenger: false,
}

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

/** The commands as a CLI made from the config mounts them: the writer over the `api` group's own write path. */
const cliOver = async (permissions: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "tracker-manifest-cli-"))
  const env = {
    TRACKER_CONFIG_DIR: join(root, "config"),
    TRACKER_STATE_DIR: join(root, "state"),
    MESSAGING_STORE: join(root, "w.db"),
  }
  mkdirSync(env.TRACKER_CONFIG_DIR, { recursive: true })
  writeFileSync(join(env.TRACKER_CONFIG_DIR, "config.json"), JSON.stringify({ profiles: { work: { permissions } } }))
  const store = await openStore({ path: join(root, "store.db") })
  opened.push(store)
  const fake = trackerManifestFake(MANIFEST, { api, definitions })
  let drop = false
  // The tracker gets the write and the connection drops before its answer arrives.
  const fetch: typeof fake.fetch = async (input, init) => {
    const answer = await fake.fetch(input, init)
    if (!drop) return answer
    drop = false
    throw new TypeError("fetch failed: the connection dropped")
  }
  const service = { manifest: api, service: "Tracker" }
  const configuration = settingsFor(APP, { permissions: commandPermissions(serviceApiPermissions(service)) })
  const apiOptions = {
    ...service,
    app: APP,
    configuration,
    fetch: () => fetch,
    token: () => FAKE_MANIFEST_TOKEN,
    schemas: async () => ({}),
    definitions: async () => definitions,
  }
  const write = serviceApiWriter(apiOptions)
  const call = serviceApiCall({ ...service, fetch: fake.fetch, token: () => FAKE_MANIFEST_TOKEN })
  const source = trackerSourceFromManifest(MANIFEST, { api, call })
  const account = { provider: "example-tracker", account: "workspace" }
  const commands = () => {
    const holder = new Command(APP.command)
    addTrackerCommands(holder, {
      app: APP,
      writes: TRACKER_WRITES,
      open: async () => ({
        account,
        store,
        source: () => source,
        writes: (invoked) => ({
          writer: trackerWriterFromManifest(MANIFEST, { api, write, command: invoked }),
          app: APP,
          env,
          settings: () => baseContext(invoked, configuration.resolveSettings).settings,
        }),
      }),
    })
    return [...holder.commands, serviceApiCommand(apiOptions)]
  }
  const cli = async (...args: string[]) => {
    const streams = captureStreams()
    const code = await run(
      ["work", ...args, "--json"],
      { app: APP, configuration, commands },
      { streams, env, tty: false },
    )
    const out = streams.stdout.join("")
    const err = streams.stderr.join("")
    return {
      code,
      json: out.startsWith("{") ? (JSON.parse(out) as { item: Row }) : undefined,
      error: err.trim() ? (JSON.parse(err.trim().split("\n").at(-1) as string).error as Row) : undefined,
    }
  }
  const mutations = () =>
    fake.calls.filter((one) => ["issueCreate", "issueUpdate", "commentCreate"].includes(one.operation ?? ""))
  const journal = () => new SendJournal(sendsPathFor(APP, "work", env)).entries()
  return { cli, fake, mutations, journal, dropNextAnswer: () => (drop = true) }
}

describe("a CLI made from the manifest writes through the api group's path", () => {
  it("asks once for the tracker's key, sends the mutation within its selection, and stores the answer", async () => {
    const { cli, fake, mutations, journal } = await cliOver({ "issues.create": "ask" })
    expect((await cli("sync")).code).toBe(0)
    const unasked = await cli(
      "issues",
      "create",
      "--title",
      "Example: refunds",
      "--team",
      "team-1",
      "--label",
      "label-1",
    )
    expect(unasked.error).toMatchObject({ code: "confirmation_required" })
    expect(mutations()).toEqual([])
    const made = await cli(
      "issues",
      "create",
      "--title",
      "Example: refunds",
      "--team",
      "team-1",
      "--label",
      "label-1",
      "--yes",
    )
    expect(made.code, JSON.stringify(made.error)).toBe(0)
    expect(made.json?.item.issue).toMatchObject({ title: "Example: refunds", team: "team-1", labels: ["label-1"] })
    expect(mutations()).toHaveLength(1)
    // The tracker's line carries the answer's operation_id; the api group's write path journals its own call too.
    const sent = journal().filter(({ outcome }) => outcome === "sent")
    expect(sent.map(({ key }) => key).sort()).toEqual(["api.issue-create", "issues.create"])
    expect(sent.find(({ key }) => key === "issues.create")?.operationId).toBe(made.json?.item.operation_id)
    const id = (made.json?.item.issue as Row | undefined)?.external_id as string
    const shown = await cli("issues", "show", id)
    expect(shown.json?.item).toMatchObject({ title: "Example: refunds" })
    const comment = await cli("issues", "comments", "create", "issue-1", "--text", "Example: seen it")
    expect(comment.json?.item.comment).toMatchObject({ issue: "issue-1", body: "Example: seen it" })
    expect(fake.refusals).toEqual([])
  })

  it("a readonly profile stops every write before it is sent", async () => {
    const { cli, mutations } = await cliOver({ issues: "readonly" })
    expect((await cli("sync")).code).toBe(0)
    const refused = await cli("issues", "comments", "create", "issue-1", "--text", "x")
    expect(refused.error).toMatchObject({ code: "permission_error" })
    expect(mutations()).toEqual([])
  })

  it("a lost answer is outcome_unknown with the tracker's operation_id, and the mutation went once", async () => {
    const { cli, mutations, journal, dropNextAnswer } = await cliOver({})
    expect((await cli("sync")).code).toBe(0)
    dropNextAnswer()
    const lost = await cli("issues", "update", "issue-1", "--title", "Example lost")
    expect(lost.error).toMatchObject({ code: "outcome_unknown" })
    expect(String(lost.error?.message)).toContain("sync and look")
    expect(mutations()).toHaveLength(1)
    const line = journal().find(({ key }) => key === "issues.update")
    expect(line).toMatchObject({ outcome: "outcome_unknown" })
    expect(JSON.stringify(lost.error)).toContain(line?.operationId as string)
  })

  it("is stopped by the operation's own api key as well", async () => {
    const { cli, mutations } = await cliOver({ "api.issue-update": "deny" })
    expect((await cli("sync")).code).toBe(0)
    expect((await cli("issues", "update", "issue-1", "--title", "X")).error).toMatchObject({ code: "permission_error" })
    expect(mutations()).toEqual([])
  })
})
