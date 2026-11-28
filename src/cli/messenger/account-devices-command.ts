import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { accountSession } from "../../entities/index.js"
import { capability } from "../../ports/messenger.js"
import { REMOTE_READ, REMOTE_WRITE } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { listQuery, typedQuery, unfilteredQuery, withQuery } from "../list-query.js"
import { markRenamedPermissionKeys } from "../permission-keys.js"
import { sessionAnswer, wholeList } from "./chat-answers.js"
import { type Messenger, messengerContext } from "./context.js"

const DEVICES_QUERY = unfilteredQuery("account_session", accountSession)

/** Owner, NEED-2916 B: `account sessions` read like this tool's own `session`, so it moved with no alias. */
const RENAMED_KEYS = new Map([
  ["account.sessions", "account.devices"],
  ["account.sessions.list", "account.devices.list"],
  ["account.sessions.end", "account.devices.end"],
])

/** `account devices …` — where else the account is logged in, not this tool's own `session`. */
export const accountDevicesCommand = (messenger: Messenger): Command => {
  const tool = `${messenger.app.command} personal`
  const devices = new Command("devices")
    .summary("devices and apps signed in to this account")
    .description(
      `where else this account is logged in — not \`${messenger.app.command} session\`, which is this tool's own login`,
    )
  markRenamedPermissionKeys(devices, RENAMED_KEYS)

  withQuery(
    annotate(devices.command("list"), { effects: REMOTE_READ, examples: [`${tool} account devices list`] }),
    DEVICES_QUERY,
  )
    .description("every device and app logged in to this account; nothing is ended")
    .action(async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger)
      listQuery(typedQuery(words), DEVICES_QUERY, "account devices list")
      const found = await context.withMessenger((adapter) =>
        capability(adapter, "sessions", "list the account's devices")(),
      )
      renderAnswer(this, context, wholeList("account devices list", found.map(sessionAnswer)))
    })

  devices.addCommand(
    annotate(new Command("end"), {
      effects: REMOTE_WRITE,
      output: { entity: "ended_account_sessions" },
      examples: [`${tool} account devices end --others`],
    })
      .description("log out every other device, your phone included; this one stays")
      .option("--others", "every device but this one")
      .action(async function (this: Command) {
        if (this.opts<{ others?: boolean }>().others !== true) {
          throw new CliError("validation_error", "only every other device can be logged out at once — add --others")
        }
        const context = messengerContext(this, messenger)
        const ended = await context.withServices((services) => services.account.endOtherSessions())
        renderAnswer(this, context, itemOf(snakeKeys({ ...ended, sessions: ended.sessions.map(sessionAnswer) })))
      }),
  )

  return devices
}
