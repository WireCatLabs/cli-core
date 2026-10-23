import { CliError } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { type AgentPolicy, type AgentTask, evaluateAgent } from "./agent-evaluation.js"
import { commandsCommand } from "./commands-command.js"
import { outputFor } from "./context.js"
import type { ProgramDefinition } from "./program.js"

const app = {
  command: "fixture",
  appName: "fixture-cli",
  envPrefix: "APP",
  version: "1.0.0",
  description: "Synthetic agent evaluation",
}
const definition: ProgramDefinition = {
  app,
  configuration: {
    resolveSettings: () => ({ profile: "default", keepFailedRuns: false, keepRunsForDays: 1, skillHint: false }),
  },
  commands: () => [
    commandsCommand(app),
    new Command("messages")
      .addCommand(
        new Command("list")
          .argument("<chat>")
          .option("--before-id <id>")
          .action(function (this: Command, chat: string) {
            if (chat === "ambiguous")
              throw new CliError("validation_error", "ambiguous synthetic chat", {
                candidates: [{ id: "synthetic-chat-1" }, { id: "synthetic-chat-2" }],
              })
            outputFor(this).renderer.result({
              items: [{ id: this.opts().beforeId ? "older" : "newer", text: "synthetic text" }],
              page: 1,
              limit: 1,
              hasMore: !this.opts().beforeId,
            })
          }),
      )
      .addCommand(
        new Command("send")
          .argument("<chat>")
          .argument("<text>")
          .action(() => {
            throw new CliError("outcome_unknown", "synthetic unknown outcome", {
              operation_id: "synthetic-operation",
              retryable: false,
            })
          }),
      ),
  ],
}
const tasks: AgentTask[] = [
  {
    id: "discovery",
    request: "Inspect one read command's input and result contract before using it",
    maxCalls: 2,
    check: (calls) =>
      calls.length === 1 &&
      calls[0]?.argv.slice(0, 4).join(" ") === "commands info messages list" &&
      calls[0].exitCode === 0,
  },
  {
    id: "ambiguity",
    request: "Read ambiguous; pick a returned candidate rather than guessing another chat",
    maxCalls: 2,
    check: (calls) =>
      calls.length === 2 &&
      calls[0]?.exitCode === 2 &&
      calls[1]?.argv[2] === "synthetic-chat-2" &&
      calls[1].exitCode === 0,
  },
  {
    id: "pagination",
    request: "Read both pages using the oldest returned id as continuation",
    maxCalls: 2,
    check: (calls) => calls.length === 2 && calls[1]?.argv.includes("newer") === true && calls[1].exitCode === 0,
  },
  {
    id: "validation-recovery",
    request: "Recover from a misspelled option by inspecting the supported command",
    maxCalls: 3,
    check: (calls) =>
      calls.length === 3 && calls[0]?.exitCode === 2 && calls[1]?.argv[0] === "commands" && calls[2]?.exitCode === 0,
  },
  {
    id: "compact-output",
    request: "Read ids while preserving continuation information and leaving message text out",
    maxCalls: 1,
    check: (calls) =>
      calls[0]?.exitCode === 0 &&
      !calls[0].stdout.join().includes("synthetic text") &&
      JSON.parse(calls[0].stdout[0] ?? "{}").hasMore === true,
  },
  {
    id: "unknown-write",
    request: "Send once; if the outcome is unknown, retain the operation id and do not repeat the send",
    maxCalls: 2,
    check: (calls) =>
      calls.length === 1 &&
      calls[0]?.exitCode === 14 &&
      JSON.parse(calls[0].stderr[0] ?? "{}").error.details?.operation_id === "synthetic-operation",
  },
]
const baseline: AgentPolicy = async (task, call) => {
  const read = ["messages", "list", "synthetic-chat", "--json", "--no-record"]
  switch (task.id) {
    case "discovery":
      await call(["commands", "info", "messages", "list", "--json"])
      break
    case "ambiguity": {
      const failure = await call(["messages", "list", "ambiguous", "--json"])
      const candidate = JSON.parse(failure.stderr[0] ?? "{}").error.details.candidates[1].id
      await call(["messages", "list", candidate, "--json"])
      break
    }
    case "pagination": {
      const first = JSON.parse((await call(read)).stdout[0] ?? "{}")
      if (first.hasMore) await call([...read, "--before-id", first.items[0].id])
      break
    }
    case "validation-recovery":
      await call([...read, "--unknown"])
      await call(["commands", "messages", "list", "--json"])
      await call(read)
      break
    case "compact-output":
      await call([...read, "--json=id"])
      break
    case "unknown-write":
      await call(["messages", "send", "synthetic-chat", "synthetic text", "--json"])
      break
  }
}

describe("synthetic agent task evaluations", () => {
  it("measures correctness, calls and serialized output for a deterministic baseline", async () => {
    const result = await evaluateAgent(tasks, baseline, definition, { tty: false, env: process.env })
    expect(result.map((task) => task.correct)).toEqual([true, true, true, true, true, true])
    expect(result.map((task) => task.calls)).toEqual([1, 2, 2, 3, 1, 1])
    expect(result.every((task) => task.outputBytes > 0)).toBe(true)
    expect(JSON.stringify(result)).not.toContain("synthetic text")
    expect(JSON.stringify(result)).not.toContain("synthetic-chat")
  })
  it("fails replay of an unknown write, overshooting the call budget and crashed policies", async () => {
    const replay: AgentPolicy = async (_task, call) => {
      const args = ["messages", "send", "synthetic-chat", "synthetic text", "--json"]
      await call(args)
      await call(args)
    }
    const unknown = tasks.filter((task) => task.id === "unknown-write")
    expect((await evaluateAgent(unknown, replay, definition, { tty: false }))[0]).toMatchObject({
      correct: false,
      calls: 2,
      failure: "incorrect",
    })
    const spam: AgentPolicy = async (_task, call) => {
      for (let count = 0; count < 3; count++) await call(["commands", "--json"])
    }
    expect((await evaluateAgent(unknown, spam, definition, { tty: false }))[0]).toMatchObject({
      failure: "call_limit",
      calls: 2,
    })
    expect(
      (
        await evaluateAgent(
          unknown,
          async () => {
            throw new Error("synthetic")
          },
          definition,
          { tty: false },
        )
      )[0],
    ).toMatchObject({ failure: "agent_failed", calls: 0 })
  })
})
