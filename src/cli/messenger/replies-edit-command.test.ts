import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { defaultRule, readReplies, readRepliesFile } from "../../replies/rules.js"
import { snakeKeys } from "../envelope.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import { repliesCommand } from "./replies-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "Test messenger", version: "1" }
const messenger: Messenger = {
  app,
  provider: "chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: async () => {
    throw new Error("reply editors must never connect")
  },
  chatArgument: "a chat",
}

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "replies-edit-"))
  const env = {
    CHAT_CONFIG_DIR: join(root, "config"),
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    MESSAGING_STORE: join(root, "store.db"),
  }
  const path = join(env.CHAT_CONFIG_DIR, "default.replies.json")
  const invoke = async (...args: string[]) => {
    const streams = captureStreams()
    const code = await run(
      ["replies", ...args, "--json"],
      { app, commands: () => [repliesCommand(messenger)] },
      { env, streams, tty: false },
    )
    return { code, data: streams.stdout.join(""), diagnostics: streams.stderr.join("") }
  }
  return { env, path, invoke }
}

describe("reply editors", () => {
  it("keeps the legacy template mode and refuses both spellings without changing the rule", async () => {
    const { path, invoke } = setup()
    expect((await invoke("add", "away")).code).toBe(0)
    expect((await invoke("edit", "away", "--model", "may-reword")).code).toBe(0)
    const before = readFileSync(path, "utf8")
    expect((await invoke("edit", "away", "--model", "fill-only", "--template-mode", "may-reword")).code).toBe(2)
    expect(readFileSync(path, "utf8")).toBe(before)
  })

  it("creates every default without a pre-existing directory, requires a template before enabling, and preserves state", async () => {
    const { env, path, invoke } = setup()
    expect(existsSync(env.CHAT_CONFIG_DIR)).toBe(false)
    expect(await invoke("add", "away")).toMatchObject({ code: 0 })
    expect(readRepliesFile(path, "chat").rules).toEqual([defaultRule("away")])
    expect(readReplies(path, "chat").rules[0]?.on).toBe(false)
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600)
    const before = readFileSync(path, "utf8")
    expect(await invoke("on", "away")).toMatchObject({ code: 2 })
    expect(readFileSync(path, "utf8")).toBe(before)
    expect(await invoke("edit", "away", "--template", "Thanks, {firstName}")).toMatchObject({ code: 0 })
    for (const command of ["on", "on", "off", "off"]) {
      const answer = await invoke(command, "away")
      expect(answer.code).toBe(0)
      expect(JSON.parse(answer.data).item.on).toBe(command === "on")
    }
    expect(existsSync(join(env.CHAT_STATE_DIR, "default.replies-state.json"))).toBe(false)
    expect(existsSync(env.MESSAGING_STORE)).toBe(false)
  })

  it("permits an empty task-only rule, but refuses adding reply to it while enabled", async () => {
    const { path, invoke } = setup()
    await invoke("add", "task")
    expect((await invoke("edit", "task", "--do", "task")).code).toBe(0)
    expect((await invoke("on", "task")).code).toBe(0)
    const before = readFileSync(path, "utf8")
    expect((await invoke("edit", "task", "--do", "task,reply")).code).not.toBe(0)
    expect(readFileSync(path, "utf8")).toBe(before)
  })

  it("sets every edit option, preserves unrelated rules, writes an older file's testers as the audience, and keeps string input forms", async () => {
    const { path, invoke } = setup()
    await invoke("add", "away")
    await invoke("add", "other")
    const { rules } = readRepliesFile(path, "chat")
    writeFileSync(path, JSON.stringify({ testers: [{ provider: "chat", id: "900719925474099399" }], rules }))
    const answer = await invoke(
      "edit",
      "away",
      "--do",
      "reply,task",
      "--kinds",
      "dialog,group",
      "--allow-chats",
      "900719925474099399,20",
      "--deny-chats",
      "21",
      "--words",
      "price, help",
      "--question",
      "--mentions-me",
      "--allow-people",
      "900719925474099398",
      "--deny-people",
      "22",
      "--contacts-only",
      "--template",
      "Hi {name}",
      "--template-mode",
      "may-reword",
      "--no-as-reply",
      "--per-chat",
      "2/12h",
      "--per-person",
      "3/1d",
      "--outside",
      "22:00-02:00",
      "--days",
      "fri-mon",
      "--timezone",
      "Europe/Madrid",
    )
    expect(answer.code).toBe(0)
    expect(JSON.parse(answer.data).item).toEqual(
      snakeKeys({
        ...defaultRule("away"),
        do: ["reply", "task"],
        where: { kinds: ["dialog", "group"], chats: ["900719925474099399", "20"], notChats: ["21"] },
        when: {
          hours: { outside: "22:00-02:00", days: "fri-mon", timezone: "Europe/Madrid" },
          words: ["price", "help"],
          question: true,
          mentionsMe: true,
          from: { people: ["900719925474099398"], notPeople: ["22"], contactsOnly: true },
        },
        reply: { template: "Hi {name}", model: "may-reword", asReply: false },
        limits: { perChat: "2/12h", perPerson: "3/1d" },
      }),
    )
    const written = JSON.parse(readFileSync(path, "utf8"))
    expect(written).not.toHaveProperty("testers")
    expect(written.audience).toEqual({
      reply: "listed",
      allow: { people: ["900719925474099399"], chats: [] },
      deny: { people: [], chats: [] },
    })
    expect(readRepliesFile(path, "chat").rules[1]).toEqual(defaultRule("other"))
    expect((await invoke("edit", "away", "--timezone", "UTC")).code).toBe(0)
    expect(readRepliesFile(path, "chat").rules[0]?.when.hours).toEqual({
      outside: "22:00-02:00",
      days: "fri-mon",
      timezone: "UTC",
    })
    expect(
      (
        await invoke(
          "edit",
          "away",
          "--no-question",
          "--no-mentions-me",
          "--no-contacts-only",
          "--as-reply",
          "--no-hours",
          "--allow-chats",
          "",
          "--deny-chats",
          "",
          "--allow-people",
          "",
          "--deny-people",
          "",
          "--words",
          "",
          "--kinds",
          "",
        )
      ).code,
    ).toBe(0)
    const cleared = readRepliesFile(path, "chat").rules[0]
    expect(cleared?.when).toEqual(defaultRule("away").when)
    expect(cleared?.where).toEqual({ kinds: [], chats: [], notChats: [] })
    expect(cleared?.reply.asReply).toBe(true)
  })

  it.each([
    ["add", "away"],
    ["add", "BAD"],
    ["on", "missing"],
    ["off", "missing"],
    ["edit", "missing", "--question"],
    ["edit", "away"],
    ["edit", "away", "--do", "nothing"],
    ["edit", "away", "--do", ""],
    ["edit", "away", "--kinds", "channel"],
    ["edit", "away", "--model", "unknown"],
    ["edit", "away", "--per-chat", "0/1d"],
    ["edit", "away", "--per-person", "unlimited"],
    ["edit", "away", "--outside", "09:00-19:00"],
    ["edit", "away", "--outside", "9-19", "--days", "mon-fri", "--timezone", "UTC"],
    ["edit", "away", "--outside", "09:00-19:00", "--days", "mon-fry", "--timezone", "UTC"],
    ["edit", "away", "--outside", "09:00-19:00", "--days", "mon-fri", "--timezone", "Mars/Olympus"],
    ["edit", "away", "--no-hours", "--days", "mon-fri"],
    ["edit", "away", "--allow-chats", "11,,12"],
    ["audience", "--reply", "none"],
  ])("refuses %j without changing the file", async (...args) => {
    const { path, invoke } = setup()
    await invoke("add", "away")
    const before = readFileSync(path, "utf8")
    const answer = await invoke(...args)
    expect(answer.code).not.toBe(0)
    expect(answer.data).toBe("")
    expect(readFileSync(path, "utf8")).toBe(before)
  })

  it("refuses malformed existing files before every editor", async () => {
    const { env, path, invoke } = setup()
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    for (const contents of ["{broken", '{"rules":[],"typo":true}']) {
      writeFileSync(path, contents)
      for (const args of [
        ["add", "away"],
        ["edit", "away", "--question"],
        ["on", "away"],
        ["off", "away"],
        ["audience", "--reply", "listed"],
      ]) {
        expect((await invoke(...args)).code).not.toBe(0)
        expect(readFileSync(path, "utf8")).toBe(contents)
      }
    }
  })

  it("shows audience without creating a file, replaces all audience fields and sends warnings only to stderr", async () => {
    const { path, invoke } = setup()
    const shown = await invoke("audience")
    expect(JSON.parse(shown.data).item.reply).toBe("all")
    expect(shown.diagnostics).toBe("")
    expect(existsSync(path)).toBe(false)
    const answer = await invoke(
      "audience",
      "--reply",
      "listed",
      "--allow-people",
      "11",
      "--allow-chats",
      "20",
      "--deny-people",
      "11",
      "--deny-chats",
      "21",
    )
    expect(answer.code).toBe(0)
    expect(JSON.parse(answer.data).item).toEqual({
      reply: "listed",
      allow: { people: ["11"], chats: ["20"] },
      deny: { people: ["11"], chats: ["21"] },
    })
    expect(answer.diagnostics).toContain("deny wins")
    expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("testers")
    const cleared = await invoke(
      "audience",
      "--allow-people",
      "",
      "--allow-chats",
      "",
      "--deny-people",
      "",
      "--deny-chats",
      "",
    )
    expect(cleared.diagnostics).toContain("nobody is answered")
    expect(JSON.parse(cleared.data).item).toEqual({
      reply: "listed",
      allow: { people: [], chats: [] },
      deny: { people: [], chats: [] },
    })
    const other = setup()
    expect(JSON.parse((await other.invoke("audience")).data).item.reply).toBe("all")
  })
})
