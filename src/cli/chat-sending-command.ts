import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import {
  CHAT_SENDING_MODES,
  type ChatSendingMode,
  chatSendingMode,
  loosens,
  readChatSending,
  writeChatSending,
} from "../models/chat-sending.js"
import type { AppIdentity } from "../ports/app.js"
import { agentOf } from "../runs/run-context.js"
import { environmentOf } from "./context.js"
import { grantsAuthority, LOCAL_READ, LOCAL_WRITE } from "./effects.js"
import { type Body, itemOf } from "./envelope.js"

export interface ChatSendingCommandOptions {
  env: (command: Command) => NodeJS.ProcessEnv
  output: (answer: Body, command: Command) => void
  /** The command line as the owner types it, such as `tg personal`; the app's command when absent. */
  tool?: (command: Command) => string
}

const MEANING: Record<ChatSendingMode, string> = {
  allowed: "chat text goes to a model outside this computer without a yes, in a terminal and over MCP",
  ask: "each send to a model outside this computer needs a yes: --yes, which an agent may pass",
  denied: "chat text never goes to a model outside this computer, even with --yes",
}

const view = (env: NodeJS.ProcessEnv) => {
  const mode = chatSendingMode(env)
  return { mode, meaning: MEANING[mode], since: readChatSending(env)?.at ?? null }
}

/**
 * `models chats`: whether `conversations embed` and `conversations links rebuild --analyze` may send chat text
 * to a model outside this computer. One setting for every WireCat tool; a model on this computer is not affected.
 */
export const chatSendingCommand = (app: AppIdentity, options: ChatSendingCommandOptions): Command => {
  const tool = (command: Command) => options.tool?.(command) ?? app.command
  const sending = annotate(new Command("chats"), { effects: LOCAL_READ }).description(
    "whether chat text may go to a model off this computer: allowed, ask or denied",
  )
  annotate(sending.command("show"), {
    effects: LOCAL_READ,
    output: { entity: "chat_sending" },
    examples: [`${app.command} models chats show`],
  })
    .description("whether chat text may go to a model outside this computer, and since when")
    .action(function (this: Command) {
      options.output(itemOf(view(options.env(this))), this)
    })
  grantsAuthority(
    annotate(sending.command("set"), {
      effects: LOCAL_WRITE,
      mcp: false,
      output: { entity: "chat_sending" },
      examples: [
        `${app.command} models chats set allowed`,
        `${app.command} models chats set ask`,
        `${app.command} models chats set denied`,
      ],
    }),
  )
    .summary("allowed, ask (the default) or denied; only you make it less strict")
    .description(
      "allowed: no yes needed; ask: --yes needed, an agent may pass it; denied: refused even with --yes. " +
        "Only you make it less strict",
    )
    .argument("<mode>", "allowed, ask or denied")
    .option("--from-app", "you did this in WireCat Desktop")
    .action(function (this: Command, given: string) {
      if (!(CHAT_SENDING_MODES as readonly string[]).includes(given))
        throw new CliError("validation_error", "say allowed, ask or denied")
      const mode = given as ChatSendingMode
      const env = options.env(this)
      const before = chatSendingMode(env)
      if (
        loosens(before, mode) &&
        (environmentOf(this).agent || agentOf(env)) &&
        !this.opts<{ fromApp?: boolean }>().fromApp
      )
        throw new CliError(
          "permission_error",
          `only the owner makes \`models chats\` less strict, not an agent: ask the owner to run \`${tool(this)} models chats set ${mode}\``,
          { reason: "chat-sending.owner-only" },
        )
      if (before !== mode) writeChatSending(env, mode)
      options.output(itemOf({ ...view(env), changed: before !== mode }), this)
    })
  return sending
}
