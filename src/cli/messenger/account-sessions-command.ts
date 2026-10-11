import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { listed } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"
import { capability } from "./port.js"

/** `account sessions …` — where else the account is logged in, not this tool's own `session`. */
export const accountSessionsCommand = (messenger: Messenger): Command => {
  const sessions = new Command("sessions").description(
    `where else this account is logged in — not \`${messenger.app.command} session\`, which is this tool's own login`,
  )

  sessions
    .command("list")
    .description("every device and app logged in to this account; nothing is ended")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const found = await context.withMessenger((adapter) =>
        capability(adapter, "sessions", "list the account's sessions")(),
      )
      if (context.format === "jsonl") context.renderer.stream(found)
      else context.renderer.result(context.format === "pretty" ? found : listed(found))
    })

  // No MCP tool, at any permission level: it logs the owner out of the phone.
  sessions.addCommand(
    annotate(new Command("end"), { mutates: true })
      .description("log out every other device, your phone included; this one stays")
      .option("--others", "every session but this one")
      .action(async function (this: Command) {
        if (this.opts<{ others?: boolean }>().others !== true) {
          throw new CliError("validation_error", "only every other session can be ended at once — add --others")
        }
        const context = messengerContext(this, messenger)
        context.renderer.result(await context.withServices((services) => services.account.endOtherSessions()))
      }),
  )

  return sessions
}
