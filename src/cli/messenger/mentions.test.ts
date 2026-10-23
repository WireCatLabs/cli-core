import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import type { Message } from "../../domain/models.js"
import { ENTITIES, type EntityName } from "../../entities/index.js"
import { openStore } from "../../store/store.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import type { Messenger } from "./context.js"
import { mentionsCommand } from "./mentions-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const messenger: Messenger = {
  app,
  provider: "chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: async () => {
    throw new Error("mentions never connect")
  },
  chatArgument: "a chat",
}

const message = (id: string, text: string, sent: string): Message => ({
  id,
  chatId: "7",
  senderId: "10",
  senderName: "Alice",
  timestamp: sent,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const setup = async (extra: Record<string, string> = {}, seeded: Message[] = []) => {
  const root = mkdtempSync(join(tmpdir(), "mentions-cli-"))
  const env = {
    ...process.env,
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
    NO_COLOR: "1",
    ...extra,
  }
  rememberAccount(app, "default", "500", env)
  const store = await openStore({ path: env.MESSAGING_STORE })
  await store.messages.saveMessages(
    { provider: "chat", account: "500" },
    "7",
    [
      message("1", "звони 8 (900) 000-00-01", "2026-10-01T10:00:00.000Z"),
      message(
        "2",
        "смета: https://docs.google.com/spreadsheets/d/1SyntheticFileId_abc/edit",
        "2026-10-02T10:00:00.000Z",
      ),
      ...seeded,
    ],
    { via: "history" },
  )
  await store.close()
  return async (...argv: string[]) => {
    const streams = captureStreams()
    const code = await run(argv, { app, commands: () => [mentionsCommand(messenger)] }, { streams, tty: false, env })
    if (code === 0 && argv.includes("--json")) {
      const names: Record<string, EntityName> = {
        list: "mention",
        domains: "mention_domain",
        places: "place",
        show: "mention.details",
        confirm: "mention_decision",
        reject: "mention_decision",
        rebuild: "mention_rebuild",
      }
      const schema = ENTITIES[names[argv[1] ?? ""] as EntityName] as v.GenericSchema
      const answer = JSON.parse(streams.stdout.join(""))
      for (const item of answer.items ?? [answer.item]) v.parse(schema, item)
    }
    return { code, stdout: streams.stdout.join(""), stderr: streams.stderr.join("\n") }
  }
}

describe("mentions", () => {
  it("**lists what the messages mention, shows one in its text, and rebuilds**", async () => {
    const chat = await setup()

    const listed = await chat("mentions", "list", "--json")
    expect(listed.code).toBe(0)
    const page = JSON.parse(listed.stdout)
    expect(page.items.map(({ kind, value }: { kind: string; value: string }) => `${kind} ${value}`)).toEqual([
      "url https://docs.google.com/spreadsheets/d/1SyntheticFileId_abc/edit",
      "document 1SyntheticFileId_abc",
      "phone +79000000001",
    ])
    expect(page.items[2].locator).toBe("msg:chat/500/7/1")
    expect(listed.stderr).toContain("mentions rebuild")

    const phones = JSON.parse((await chat("mentions", "list", "89000000001", "--json")).stdout)
    expect(phones.items.map(({ value }: { value: string }) => value)).toEqual(["+79000000001"])

    const sites = JSON.parse((await chat("mentions", "list", "domain:Docs.Google.com", "kind:url", "--json")).stdout)
    expect(sites.items).toHaveLength(1)

    const phone = page.items[2]
    const shown = JSON.parse((await chat("mentions", "show", String(phone.id), "--json")).stdout)
    expect(shown.item).toMatchObject({ written: "8 (900) 000-00-01", before: "звони ", after: "" })

    const rebuilt = await chat("mentions", "rebuild", "--json")
    expect(rebuilt.code).toBe(0)
    expect(JSON.parse(rebuilt.stdout).item).toEqual({
      messages: 2,
      attachments: 0,
      documents: 0,
      notes: 0,
      emails: 0,
      mentions: 3,
    })
    expect((await chat("mentions", "list", "--json")).stderr).not.toContain("mentions rebuild")
    const names = await chat("mentions", "rebuild", "person-name", "--json")
    expect(names.code, names.stderr).toBe(0)
    expect((await chat("mentions", "rebuild", "vehicle")).code).not.toBe(0)
  })

  it("projects declared mention fields and refuses an unknown field", async () => {
    const chat = await setup()
    const projected = await chat("mentions", "list", "kind:phone", "--json=value,locator")
    expect(projected.code, projected.stderr).toBe(0)
    expect(JSON.parse(projected.stdout).items).toEqual([{ value: "+79000000001", locator: "msg:chat/500/7/1" }])
    const unknown = await chat("mentions", "list", "--json=unknown_field")
    expect(unknown.code).not.toBe(0)
    expect(JSON.parse(unknown.stderr).error.reason).toBe("output.unknown-field")
  })

  it("pages confirmed places through the shared CLI and stops at the end", async () => {
    const chat = await setup({}, [
      message("3", "12 Fictional Example Street", "2026-10-03T10:00:00.000Z"),
      message("4", "34 Synthetic Sample Road", "2026-10-04T10:00:00.000Z"),
    ])
    const mentions = await chat("mentions", "list", "kind:place", "--json")
    expect(mentions.code, mentions.stderr).toBe(0)
    const candidates = JSON.parse(mentions.stdout).items as { id: number }[]
    expect(candidates).toHaveLength(2)
    for (const candidate of candidates) {
      const confirmed = await chat("mentions", "confirm", String(candidate.id), "--as-owner", "--json")
      expect(confirmed.code, confirmed.stderr).toBe(0)
    }
    const pages = []
    for (const page of [1, 2, 3]) {
      const result = await chat("mentions", "places", "--limit", "1", "--page", String(page), "--json")
      expect(result.code, result.stderr).toBe(0)
      pages.push(JSON.parse(result.stdout))
    }
    expect(pages[0].items).toHaveLength(1)
    expect(pages[1].items).toHaveLength(1)
    expect(pages[0].items[0].id).not.toBe(pages[1].items[0].id)
    expect(pages[2].items).toEqual([])
    expect(pages[0].page.has_more).toBe(true)
    expect(pages[1].page.has_more).toBe(false)
  })

  it("refuses a kind it does not know and a mention of nothing, and lists its fields in help", async () => {
    const chat = await setup()
    expect((await chat("mentions", "list", "kind:fax")).code).not.toBe(0)
    const help = await chat("mentions", "list", "--help")
    for (const field of ["kind", "status", "domain", "value"]) expect(help.stdout).toContain(field)
    const missing = await chat("mentions", "show", "999", "--json")
    expect(missing.code).not.toBe(0)
    expect(missing.stderr + missing.stdout).toContain("no mention 999")
  })

  it("records who decided: the agent whose terminal runs it, or the owner with --as-owner", async () => {
    const chat = await setup({ AI_AGENT: "claude-code_2-1-296_agent" })
    const [link] = JSON.parse((await chat("mentions", "list", "kind:url", "--json")).stdout).items
    const [document] = JSON.parse((await chat("mentions", "list", "kind:document", "--json")).stdout).items

    const rejected = await chat("mentions", "reject", String(link.id), "--json")
    expect(rejected.code, rejected.stderr).toBe(0)
    expect(JSON.parse(rejected.stdout)).toMatchObject({ item: { status: "dismissed", mentions: 1 } })
    const shown = JSON.parse((await chat("mentions", "list", "status:dismissed", "--json")).stdout)
    expect(shown.items).toMatchObject([{ author: "claude-code" }])

    const unstored = await chat("mentions", "confirm", String(document.id), "--as-owner", "--json")
    expect(unstored.code).not.toBe(0)
    expect(unstored.stderr).toContain("not in the store yet")
  })

  it("lists only undecided mentions found since the last --new run that showed them all", async () => {
    const chat = await setup()
    const values = async (...argv: string[]) =>
      (
        JSON.parse((await chat("mentions", "list", ...argv, "--json")).stdout) as { items: { value: string }[] }
      ).items.map((item) => item.value)

    expect(await values("--new")).toEqual([
      "https://docs.google.com/spreadsheets/d/1SyntheticFileId_abc/edit",
      "1SyntheticFileId_abc",
      "+79000000001",
    ])
    expect(await values("--new")).toEqual([])
    expect(await values("kind:phone")).toEqual(["+79000000001"])
  })

  it("counts the links per site, most linked first", async () => {
    const chat = await setup()

    const { code, stdout } = await chat("mentions", "domains", "--json")

    expect(code).toBe(0)
    expect(JSON.parse(stdout).items).toEqual([
      {
        domain: "google.com",
        links: 1,
        chats: 1,
        first_at: "2026-10-02T10:00:00.000Z",
        last_at: "2026-10-02T10:00:00.000Z",
      },
    ])
  })
})
