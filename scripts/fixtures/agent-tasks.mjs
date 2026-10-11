import { appendFileSync } from "node:fs"
import { CliError, captureStreams } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { commandsCommand } from "../../dist/cli/commands-command.js"
import { outputFor } from "../../dist/cli/context.js"
import { run } from "../../dist/cli/program.js"

const app = {
  command: "max",
  appName: "synthetic-max",
  envPrefix: "APP",
  version: "0.0.0-fixture",
  description: "Isolated synthetic messenger; no network, keyring or real account exists",
}
const streams = captureStreams()
const path = []
const code = await run(
  process.argv.slice(2),
  {
    app,
    configuration: {
      resolveSettings: () => ({
        profile: "default",
        keepFailedRuns: false,
        keepRunsForDays: 1,
        skillHint: false,
        permissions: {},
      }),
    },
    configure: (program) =>
      program.hook("preAction", (_root, action) => {
        for (let at = action; at.parent; at = at.parent) path.unshift(at.name())
      }),
    commands: () => [
      commandsCommand(app),
      new Command("chats").addCommand(
        new Command("list").action(function () {
          outputFor(this).renderer.result({
            items: [
              { id: "synthetic-product", title: "Team Product" },
              { id: "synthetic-operations", title: "Team Operations" },
            ],
            page: 1,
            limit: 2,
            hasMore: false,
          })
        }),
      ),
      new Command("messages")
        .addCommand(
          new Command("list")
            .argument("<chat>")
            .option("--limit <n>", "how many messages")
            .option("--before-id <id>", "older than this returned message")
            .action(function (chat) {
              if (chat === "Team")
                throw new CliError("validation_error", "Team matches two synthetic chats", {
                  candidates: [
                    { id: "synthetic-product", title: "Team Product" },
                    { id: "synthetic-operations", title: "Team Operations" },
                  ],
                })
              const older = this.opts().beforeId === "synthetic-newer"
              outputFor(this).renderer.result({
                items: [
                  {
                    id: older ? "synthetic-older" : "synthetic-newer",
                    chatId: chat === "Team Product" ? "synthetic-product" : chat,
                    text: "synthetic message text",
                  },
                ],
                page: 1,
                limit: 1,
                hasMore: !older,
              })
            }),
        )
        .addCommand(
          annotate(
            new Command("send")
              .argument("<chat>")
              .argument("<text>")
              .action(() => {
                throw new CliError(
                  "outcome_unknown",
                  "the synthetic write outcome is unknown; inspect its operation before repeating it",
                  { operationId: "synthetic-operation", retryable: false },
                )
              }),
            { mutates: true },
          ),
        ),
      new Command("sends").addCommand(
        new Command("list").option("--limit <n>", "how many journal entries").action(function () {
          outputFor(this).renderer.result({
            items: [{ operationId: "synthetic-operation", outcome: "outcome_unknown", retryable: false }],
            page: 1,
            limit: 1,
            hasMore: false,
          })
        }),
      ),
    ],
  },
  { streams, tty: false, env: { APP_STATE_DIR: process.env.EVAL_DIR, APP_CONFIG_DIR: process.env.EVAL_DIR } },
)
const parsed = streams.stdout.flatMap((text) => {
  try {
    return [JSON.parse(text)]
  } catch {
    return []
  }
})
const errors = streams.stderr.flatMap((text) => {
  try {
    return [JSON.parse(text).error]
  } catch {
    return []
  }
})
appendFileSync(
  process.env.EVAL_METRICS,
  `${JSON.stringify({
    task: process.env.EVAL_TASK,
    path: path.length ? path : process.argv.slice(2, 4),
    exitCode: code,
    calls: 1,
    outputBytes: [...streams.stdout, ...streams.stderr].reduce((sum, text) => sum + Buffer.byteLength(text) + 1, 0),
    ids: parsed.flatMap((value) => value.items?.map((item) => item.id) ?? []),
    chatIds: parsed.flatMap((value) => value.items?.map((item) => item.chatId).filter(Boolean) ?? []),
    itemKeys: parsed.flatMap((value) => value.items?.map((item) => Object.keys(item)) ?? []),
    hasMore: parsed.map((value) => value.hasMore).filter((value) => value !== undefined),
    errorCodes: errors.map((error) => error?.code),
    operationIds: [...parsed, ...errors, ...parsed.flatMap((value) => value.items ?? [])]
      .map((value) => value?.operationId)
      .filter(Boolean),
  })}\n`,
)
for (const text of streams.stdout) process.stdout.write(`${text}\n`)
for (const text of streams.stderr) process.stderr.write(`${text}\n`)
process.exitCode = code
