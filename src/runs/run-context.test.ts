import { Command, Option } from "commander"
import { describe, expect, it } from "vitest"
import { agentOf, maskArgv } from "./run-context.js"

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

  it("drops a session id that is not shaped like one", () => {
    expect(agentOf({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "a b; rm -rf" })).toEqual({
      kind: "claude-code",
      session_id: null,
    })
  })
})
