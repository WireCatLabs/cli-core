import { captureStreams } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { outputFor } from "./context.js"
import { listOf, renderAnswer } from "./envelope.js"
import { positiveCount } from "./paging.js"
import { run } from "./program.js"

const text = "Встречаемся в четверг, я принесу вторую часть книги и список на ноябрь, посмотрите до пятницы. ".repeat(3)

const msg = (id: number) => ({
  ref: `msg:max/500/-1001/${id}`,
  id: String(id),
  chat_id: "-1001",
  chat_title: "Книжный клуб",
  sender_id: "77",
  sender_name: "Анна",
  sender_is_me: false,
  timestamp: new Date(Date.UTC(2026, 9, 1) + id * 60_000).toISOString(),
  edited_at: null,
  text,
  outgoing: false,
  attachments: [],
  reply_to: null,
  forwarded_from: null,
})

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "synthetic", version: "1.0.0" }
const definition = {
  app,
  commands: () => [
    new Command("messages").addCommand(
      annotate(
        new Command("list")
          .argument("<chat>")
          .option("--limit <n>", "how many", positiveCount("--limit"), 50)
          .option("--next <n>", "steps the answer already names", positiveCount("--next"))
          .action(function (this: Command, chat: string) {
            const { limit, next } = this.opts<{ limit: number; next?: number }>()
            const step = {
              kind: "user_action" as const,
              step: "fixture.step",
              why: "the fixture names it",
              safe_to_auto_execute: false as const,
            }
            renderAnswer(
              this,
              outputFor(this),
              listOf("messages list", {
                items: Array.from({ length: limit }, (_, index) => msg(index + 1)),
                limit,
                has_more: false,
                args: { chat },
                next: Array.from({ length: next ?? 0 }, () => step),
              }),
            )
          }),
        { output: { entity: "message" }, effects: { local: "read", remote: "none" } },
      ),
    ),
  ],
}

const call = async (...argv: string[]) => {
  const streams = captureStreams()
  const code = await run([...argv, "--no-record"], definition, { streams, tty: false, env: process.env })
  return { code, stdout: streams.stdout.join("\n"), stderr: streams.stderr.join("\n") }
}

const lineArgs = (line: string) => line.split(" ").slice(1)

describe("output over the cap", () => {
  it("fails with two reads that fit, and each one runs as it is", async () => {
    const failed = await call("messages", "list", "-1001", "--limit", "6000", "--json")
    expect(failed.code).not.toBe(0)
    expect(failed.stdout).toBe("")
    const { error } = JSON.parse(failed.stderr)
    expect(error.reason).toBe("output.too-large")
    expect(error.next.map((step: { line: string }) => step.line)).toEqual([
      "chat messages list -1001 --limit 6000 --compact",
      expect.stringMatching(/^chat messages list -1001 --limit \d+ --json$/),
    ])
    expect(error.next.every((step: { safe_to_auto_execute: boolean }) => step.safe_to_auto_execute)).toBe(true)
    expect(JSON.stringify(error.next)).not.toContain("четверг")

    for (const { line } of error.next) {
      const rerun = await call(...lineArgs(line))
      expect(rerun.code).toBe(0)
      expect(rerun.stdout.length).toBeGreaterThan(0)
    }
  })

  it("suggests only a smaller --limit when the compact form is already over it", async () => {
    const failed = await call("messages", "list", "-1001", "--limit", "300", "--compact", "--max-output-bytes", "20000")
    const { error } = JSON.parse(failed.stderr)
    expect(error.next).toHaveLength(1)
    expect(error.next[0].line).toMatch(/^chat messages list -1001 --limit \d+ --compact --max-output-bytes 20000$/)
    expect((await call(...lineArgs(error.next[0].line))).code).toBe(0)
  })
})

describe("a large JSON answer", () => {
  const nextOf = async (...argv: string[]) => JSON.parse((await call(...argv)).stdout).next

  it("is printed whole with one more step to the compact form past 256 KiB, and none under it", async () => {
    const large = await call("messages", "list", "-1001", "--limit", "500", "--json")
    expect(large.code).toBe(0)
    const answer = JSON.parse(large.stdout)
    expect(answer.items).toHaveLength(500)
    expect(answer.next).toMatchObject([
      { step: "output.compact", line: "chat messages list -1001 --limit 500 --compact", safe_to_auto_execute: true },
    ])
    expect(await nextOf("messages", "list", "-1001", "--limit", "150", "--json")).toBeUndefined()
  })

  it("adds no step when the answer already names two", async () => {
    expect(await nextOf("messages", "list", "-1001", "--limit", "500", "--next", "2", "--json")).toHaveLength(2)
  })
})
