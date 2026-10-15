import * as v from "valibot"
import { parseDuration } from "../domain/duration.js"
import type { ThreadOptions } from "../services/thread-context.js"

export const threadInputs = {
  thread: v.optional(v.boolean()),
  thread_hops: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(50))),
  thread_messages: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500))),
  thread_bytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_048_576))),
  thread_within: v.optional(v.string()),
}
export const threadArgs = (args: {
  thread?: boolean
  thread_hops?: number
  thread_messages?: number
  thread_bytes?: number
  thread_within?: string
}): { thread?: ThreadOptions } =>
  args.thread
    ? {
        thread: {
          ...(args.thread_hops === undefined ? {} : { maxHops: args.thread_hops }),
          ...(args.thread_messages === undefined ? {} : { maxMessages: args.thread_messages }),
          ...(args.thread_bytes === undefined ? {} : { maxBytes: args.thread_bytes }),
          ...(args.thread_within === undefined ? {} : { withinMs: parseDuration(args.thread_within, "thread_within") }),
        },
      }
    : {}
