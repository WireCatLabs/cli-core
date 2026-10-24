import { CliError } from "@wirecat/cli-base"
import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { note } from "../entities/note.js"
import { addMeetingCommands } from "../meetings/cli/index.js"
import type { AppIdentity } from "../ports/app.js"
import { commandsCommand } from "./commands-command.js"
import { LOCAL_READ, LOCAL_WRITE, NO_EFFECTS, REMOTE_WRITE } from "./effects.js"
import { unfilteredQuery, withQuery } from "./list-query.js"
import type { Messenger } from "./messenger/context.js"
import { doctorCommand } from "./messenger/doctor-command.js"
import { mcpCommand } from "./messenger/mcp-command.js"
import { searchCommand } from "./messenger/search-command.js"
import { settingsFor } from "./settings.js"

/** Construction-only defaults for a CLI that explicitly binds an independent source or transport. */
export const sharedCommandTemplate = (
  app: AppIdentity,
  name: "commands" | "doctor" | "mcp" | "search" | "notes" | "session" | "setup" | "meetings",
): Command => {
  const unavailable = (): never => {
    throw new CliError("configuration_error", "a command contract template cannot execute")
  }
  const messenger: Messenger = {
    app,
    provider: app.command,
    chatArgument: "a stored chat id or name",
    topics: false,
    history: "store",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => unavailable(),
  }
  const command = sharedCommand(() => {
    if (name === "commands") return commandsCommand(app)
    if (name === "doctor") return doctorCommand(messenger)
    if (name === "mcp") return mcpCommand(messenger)
    if (name === "search") return searchCommand(messenger)
    if (name === "meetings") {
      const root = new Command(app.command)
      addMeetingCommands(root, {
        get store() {
          return unavailable()
        },
        accountId: 0,
        write: unavailable,
      })
      const meetings = root.commands.find((command) => command.name() === "meetings")
      if (!meetings) return unavailable()
      return meetings
    }
    if (name === "setup")
      return annotate(new Command("setup"), { effects: REMOTE_WRITE, lifetime: "interactive", mcp: false })
        .description("set up the account and connect an agent")
        .option("--agent <agent>", "install instructions for this agent")
        .option("--method <method>", "login method")
    if (name === "session") {
      const session = annotate(new Command("session"), { effects: NO_EFFECTS, mcp: false }).description(
        "link this account, or end its login",
      )
      annotate(session.command("start"), { effects: REMOTE_WRITE, lifetime: "interactive" })
        .description("link this account")
        .argument("[method]", "login method")
      annotate(session.command("end"), { effects: REMOTE_WRITE }).description("end this account's login")
      return session
    }
    const notes = annotate(new Command("notes"), { effects: NO_EFFECTS }).description("notes kept in the shared store")
    withQuery(
      annotate(notes.command("list"), { effects: LOCAL_READ, output: { entity: "note" } }).description(
        "list stored notes",
      ),
      unfilteredQuery("note", note),
    )
    annotate(notes.command("show"), { effects: LOCAL_READ, output: { entity: "note" } })
      .description("show one note")
      .argument("<note>", "stored note reference")
    annotate(notes.command("add"), { effects: LOCAL_WRITE, output: { entity: "note" } })
      .description("write a note")
      .argument("<text>", "note text")
      .option("--subject <ref>", "stored resource the note describes")
    annotate(notes.command("edit"), { effects: LOCAL_WRITE, output: { entity: "note" } })
      .description("change a note")
      .argument("<note>", "stored note reference")
      .argument("<text>", "replacement text")
    annotate(notes.command("remove"), { effects: LOCAL_WRITE })
      .description("remove a note")
      .argument("<note>", "stored note reference")
    return notes
  })()
  command.hook("preAction", unavailable)
  return command
}
