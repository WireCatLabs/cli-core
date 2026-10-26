import { Argument, Command, Option } from "commander"
import { describe, expect, it } from "vitest"
import { agentOf, maskArgv, secretInput } from "./run-context.js"

const program = () => {
  const root = new Command("max").option("--json").option("--timeout <duration>").option("--profile <name>")
  const messages = root.command("messages")
  messages
    .command("send")
    .argument("<chat>")
    .argument("<text...>")
    .option("--caption <caption>")
    .option("--reply-to <id>")
    .addOption(new Option("--format <format>").choices(["plain", "markdown"]))
  messages.command("list").argument("[chat]").option("--limit <n>").option("--since <date>").option("--query <q>")
  root.command("contacts").command("add").argument("<phone>")
  return root
}

describe("maskArgv", () => {
  it("keeps command words, flags, numbers, dates, durations and declared choices", () => {
    expect(
      maskArgv(program(), [
        "work",
        "--json",
        "messages",
        "list",
        "-1001234567890",
        "--limit",
        "20",
        "--since",
        "2026-10-01",
        "--timeout=30s",
      ]).argv,
    ).toEqual([
      "work",
      "--json",
      "messages",
      "list",
      "-1001234567890",
      "--limit",
      "20",
      "--since",
      "2026-10-01",
      "--timeout=30s",
    ])
  })

  it("masks message text, a chat typed by title, a caption, a query and a phone number", () => {
    expect(
      maskArgv(program(), [
        "messages",
        "send",
        "Mom",
        "see",
        "you",
        "at",
        "5",
        "--caption",
        "beach",
        "--format",
        "markdown",
        "--reply-to",
        "42",
      ]).argv,
    ).toEqual([
      "messages",
      "send",
      "[redacted]",
      "[redacted]",
      "[redacted]",
      "[redacted]",
      "[redacted]",
      "--caption",
      "[redacted]",
      "--format",
      "markdown",
      "--reply-to",
      "42",
    ])
    expect(maskArgv(program(), ["messages", "list", "--query=salary"]).argv).toEqual([
      "messages",
      "list",
      "--query=[redacted]",
    ])
    expect(maskArgv(program(), ["contacts", "add", "79161234567"]).argv).toEqual(["contacts", "add", "[redacted]"])
    expect(maskArgv(program(), ["messages", "list", "79161234567"]).argv).toEqual(["messages", "list", "[redacted]"])
  })

  it("masks everything after -- and the value of a flag nobody declared", () => {
    expect(maskArgv(program(), ["messages", "send", "777", "--", "--not-a-flag", "hi"]).argv).toEqual([
      "messages",
      "send",
      "777",
      "--",
      "[redacted]",
      "[redacted]",
    ])
    expect(maskArgv(program(), ["messages", "list", "--bogus=secret"]).argv).toEqual([
      "messages",
      "list",
      "--bogus=[redacted]",
    ])
  })

  it("names the word that is no command, masked when it is not shaped like one", () => {
    expect(maskArgv(program(), ["work", "mesages", "list"])).toEqual({
      argv: ["work", "mesages", "[redacted]"],
      unknownCommand: "mesages",
    })
    expect(maskArgv(program(), ["work", "send mom hi"]).unknownCommand).toBe("[redacted]")
    expect(maskArgv(program(), ["call me at +7916"]).argv).toEqual(["[redacted]"])
  })
})

describe("maskArgv with keep, as `record_input` is by default", () => {
  const keep = { keep: true }

  it("keeps every word as typed: text, a chat by title, after -- and a mistyped command", () => {
    const typed = ["work", "messages", "send", "Mom", "see you at 5", "--caption=beach", "--", "--not-a-flag"]
    expect(maskArgv(program(), typed, keep).argv).toEqual(typed)
    expect(maskArgv(program(), ["work", "mesages", "hi there"], keep)).toEqual({
      argv: ["work", "mesages", "hi there"],
      unknownCommand: "mesages",
    })
  })

  it("hides a marked input, one named for a secret, and a word shaped like a credential", () => {
    const root = program()
    root.addOption(secretInput(new Option("--pin <code>")))
    root.command("login").addArgument(secretInput(new Argument("<code>")))
    const opaque = "A".repeat(20) + "1".repeat(20)

    expect(maskArgv(root, ["login", "12345", "--pin", "4321"], keep).argv).toEqual([
      "login",
      "[redacted]",
      "--pin",
      "[redacted]",
    ])
    expect(
      maskArgv(root, ["messages", "list", "--access-token=t", "--password", "p", "--api-key=k", "--secret", "s"], keep)
        .argv,
    ).toEqual([
      "messages",
      "list",
      "--access-token=[redacted]",
      "--password",
      "[redacted]",
      "--api-key=[redacted]",
      "--secret",
      "[redacted]",
    ])
    expect(maskArgv(root, ["messages", "list", "socks5://me:hunter2@host:1080"], keep).argv).toEqual([
      "messages",
      "list",
      "[redacted]",
    ])
    expect(maskArgv(root, ["messages", "send", "777", opaque], keep).argv).toEqual([
      "messages",
      "send",
      "777",
      "[redacted]",
    ])
  })

  it("hides a phone number wherever it is typed and keeps the words around it", () => {
    expect(maskArgv(program(), ["contacts", "add", "79161234567"], keep).argv).toEqual([
      "contacts",
      "add",
      "[redacted]",
    ])
    expect(
      maskArgv(program(), ["messages", "send", "-1001234567890", "call +7 (916) 123-45-67 or 79161234567 at 5"], keep)
        .argv,
    ).toEqual(["messages", "send", "-1001234567890", "call [redacted] or [redacted] at 5"])
    expect(maskArgv(program(), ["79161234567", "messages", "list"], keep).argv).toEqual([
      "[redacted]",
      "messages",
      "list",
    ])
  })
})

describe("agentOf", () => {
  it("reads each agent's own variables, and a session only where the agent sets one", () => {
    expect(agentOf({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "46ea6dc8-e640" })).toEqual({
      kind: "claude-code",
      session_id: "46ea6dc8-e640",
    })
    expect(agentOf({ AI_AGENT: "claude-code_2-1-310_agent", CLAUDE_CODE_SESSION_ID: "abc" })).toEqual({
      kind: "claude-code",
      session_id: "abc",
    })
    expect(agentOf({ CODEX_THREAD_ID: "019a-thread" })).toEqual({ kind: "codex", session_id: "019a-thread" })
    expect(agentOf({ OPENCODE: "1", AI_AGENT: "opencode", OPENCODE_SESSION_ID: "ses_1" })).toEqual({
      kind: "opencode",
      session_id: "ses_1",
    })
    expect(agentOf({ GEMINI_CLI: "1" })).toEqual({ kind: "gemini-cli", session_id: null })
    expect(agentOf({ CURSOR_AGENT: "1" })).toEqual({ kind: "cursor", session_id: null })
    expect(agentOf({})).toBeUndefined()
  })

  it("reads Hermes's session, as Hermes names it for every command it runs", () => {
    expect(agentOf({ AI_AGENT: "hermes-agent", HERMES_SESSION_ID: "20260901_015036_21865a" })).toEqual({
      kind: "hermes-agent",
      session_id: "20260901_015036_21865a",
    })
    expect(agentOf({ AI_AGENT: "hermes-agent" })).toEqual({ kind: "hermes-agent", session_id: null })
    expect(agentOf({ HERMES_SESSION_ID: "20260901_015036_21865a" })).toBeUndefined()
  })

  it("names OpenClaw only for its agent's commands, and keeps that a chat started one but never who sent it", () => {
    expect(agentOf({ OPENCLAW_SHELL: "exec" })).toEqual({ kind: "openclaw", session_id: null })
    const fromChat = agentOf({
      OPENCLAW_SHELL: "exec",
      OPENCLAW_CHANNEL_CONTEXT: '{"sender":{"id":"sender-1"},"chat":{"id":"chat-1"}}',
    })
    expect(fromChat).toEqual({ kind: "openclaw", session_id: null, from_chat: true })
    expect(JSON.stringify(fromChat)).not.toMatch(/sender-1|chat-1/)
    expect(agentOf({ OPENCLAW_SHELL: "tui-local" })).toBeUndefined()
    expect(agentOf({ OPENCLAW_SHELL: "exec", CLAUDECODE: "1" })).toEqual({ kind: "claude-code", session_id: null })
  })

  it("drops a session id that is not shaped like one", () => {
    expect(agentOf({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "a b; rm -rf" })).toEqual({
      kind: "claude-code",
      session_id: null,
    })
  })
})
