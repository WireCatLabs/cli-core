import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { accountSession } from "../../entities/index.js"
import { capability } from "../../ports/messenger.js"
import { REMOTE_READ, REMOTE_WRITE } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { listQuery, typedQuery, unfilteredQuery, withQuery } from "../list-query.js"
import { sessionAnswer, wholeList } from "./chat-answers.js"
import { type Messenger, messengerContext } from "./context.js"

const SESSIONS_QUERY = unfilteredQuery("account_session", accountSession)

/** `account sessions …` — where else the account is logged in, not this tool's own `session`. */
export const accountSessionsCommand = (messenger: Messenger): Command => {
  const sessions = new Command("sessions").description(
    `where else this account is logged in — not \`${messenger.app.command} session\`, which is this tool's own login`,
  )

  withQuery(annotate(sessions.command("list"), { effects: REMOTE_READ }), SESSIONS_QUERY)
    .description("every device and app logged in to this account; nothing is ended")
    .action(async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger)
      listQuery(typedQuery(words), SESSIONS_QUERY, "account sessions list")
      const found = await context.withMessenger((adapter) =>
        capability(adapter, "sessions", "list the account's sessions")(),
      )
      renderAnswer(this, context, wholeList("account sessions list", found.map(sessionAnswer)))
    })

  // No MCP tool, at any permission level: it logs the owner out of the phone.
  sessions.addCommand(
    annotate(new Command("end"), { effects: REMOTE_WRITE, mcp: false, output: { entity: "ended_account_sessions" } })
      .description("log out every other device, your phone included; this one stays")
      .option("--others", "every session but this one")
      .action(async function (this: Command) {
        if (this.opts<{ others?: boolean }>().others !== true) {
          throw new CliError("validation_error", "only every other session can be ended at once — add --others")
        }
        const context = messengerContext(this, messenger)
        const ended = await context.withServices((services) => services.account.endOtherSessions())
        renderAnswer(this, context, itemOf(snakeKeys({ ...ended, sessions: ended.sessions.map(sessionAnswer) })))
      }),
  )

  return sessions
}
