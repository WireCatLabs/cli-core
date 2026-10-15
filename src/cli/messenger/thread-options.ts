import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import { parseDuration } from "../../domain/duration.js"
import type { ThreadOptions } from "../../services/thread-context.js"
import { environmentOf } from "../context.js"
import { positiveCount } from "../paging.js"

export const threadOptions = (command: Command): Command =>
  command
    .option(
      "--thread",
      "the stored reply chain and replies instead of time neighbours; falls back when no graph exists",
    )
    .option("--thread-hops <n>", "at most this many links from the hit (default: 8)", (value: string) => {
      if (!/^\d+$/.test(value.trim()))
        throw new CliError("validation_error", "--thread-hops takes a whole number from zero upwards")
      return Number(value)
    })
    .option(
      "--thread-messages <n>",
      "at most this many messages in each thread context (default: 50)",
      positiveCount("--thread-messages"),
    )
    .option(
      "--thread-bytes <n>",
      "at most this many bytes of whole messages and links in each context (default: 65536)",
      positiveCount("--thread-bytes"),
    )
    .option("--thread-within <duration>", "messages within this long either side of the hit (default: 1d)")

export const threadRequest = (command: Command): { thread?: ThreadOptions } => {
  const options = command.opts<{
    thread?: boolean
    threadHops?: number
    threadMessages?: number
    threadBytes?: number
    threadWithin?: string
  }>()
  if (!options.thread) return {}
  return {
    thread: {
      ...(options.threadHops === undefined ? {} : { maxHops: options.threadHops }),
      ...(options.threadMessages === undefined ? {} : { maxMessages: options.threadMessages }),
      ...(options.threadBytes === undefined ? {} : { maxBytes: options.threadBytes }),
      ...(options.threadWithin === undefined
        ? {}
        : { withinMs: parseDuration(options.threadWithin, "--thread-within") }),
      signal: environmentOf(command).signal,
    },
  }
}
