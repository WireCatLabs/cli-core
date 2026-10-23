import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { FloodMemory, floodPathFor, holdEnd } from "../../sends/flood.js"
import { DEFAULT_PACE, Pacer, pacePathFor } from "../../sends/pace.js"
import { grantsAuthority, LOCAL_WRITE } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { type Messenger, messengerContext } from "./context.js"

/**
 * The owner's way out of a remembered wait or a hold on writes, once they know it is over. No MCP
 * tool on purpose: an agent that could lift a hold would send straight into a spam limit again.
 */
export const floodCommand = (messenger: Messenger): Command => {
  const { app } = messenger
  const name = messenger.name ?? app.command
  return annotate(new Command("flood"), { mcp: false })
    .description(`the waits ${name} asked this profile to keep, and a hold on its writes`)
    .addCommand(
      grantsAuthority(
        annotate(new Command("clear"), { effects: LOCAL_WRITE, examples: [`${app.command} personal flood clear`] }),
      )
        .summary("clear a profile's stored rate-limit hold")
        .description(
          `forget them, lift the hold and the profile's pace, once ${name} no longer limits the account; changes nothing there`,
        )
        .action(async function (this: Command) {
          const context = messengerContext(this, messenger)
          const { profile } = context
          const { deadlines, sendBlock } = new FloodMemory(floodPathFor(app, profile, context.env)).clear()
          await new Pacer(pacePathFor(app, profile, context.env), DEFAULT_PACE).reset()
          const waits = deadlines.map(
            (one) =>
              `- the wait before ${one.operation}${one.chatId ? ` in chat ${one.chatId}` : ""}, until ${one.until}`,
          )
          const hold = sendBlock ? [`- the hold on writes (${sendBlock.state}), ${holdEnd(sendBlock)}`] : []
          renderAnswer(
            this,
            context,
            itemOf(snakeKeys({ profile, cleared: { deadlines, sendBlock: sendBlock ?? null } })),
            () =>
              waits.length + hold.length === 0
                ? `Nothing to clear for profile ${profile}.`
                : [`Cleared for profile ${profile}:`, ...hold, ...waits].join("\n"),
          )
        }),
    )
}
