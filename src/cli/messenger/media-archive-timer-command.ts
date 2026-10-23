import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import {
  dailyArchiveTimer,
  manageDailyArchiveTimer,
  runArchiveTimerCommand,
} from "../../background/daily-archive-timer.js"
import { type ServerSystem, thisMachine } from "../../background/system.js"
import { refusedPlace } from "../../sends/upload.js"
import { validateMediaSince } from "../../services/media-archive.js"
import { type BaseEnvironment, environmentOf } from "../context.js"
import { grantsAuthority, LOCAL_READ, LOCAL_WRITE } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { type Messenger, messengerContext } from "./context.js"

export const addMediaArchiveTimers = (attachments: Command, messenger: Messenger): void => {
  const archive = attachments.command("jobs").description("daily media archive timers for this profile")
  for (const action of ["install", "start", "stop", "status", "uninstall"] as const) {
    const command = annotate(archive.command(action), {
      effects: action === "status" ? LOCAL_READ : LOCAL_WRITE,
      mcp: false,
      examples: [`${messenger.app.command} attachments jobs ${action} ./media-archive`],
    })
      .description(
        {
          install: "install a Linux daily archive timer for this directory; starts nothing",
          start: "enable the installed archive timer at login and start its daily schedule",
          stop: "disable the archive timer; a download already running finishes",
          status: "show whether this directory's archive timer is installed and active",
          uninstall: "remove this directory's stopped archive timer; keep archived files",
        }[action],
      )
      .argument("<dir>", "archive directory, used with the same profile as install")
    if (action !== "status") grantsAuthority(command)
    if (action === "install")
      command
        .option("--at <HH:mm>", "daily start time", "03:00")
        .option("--timezone <zone>", "IANA time zone of the daily start time", "UTC")
        .option(
          "--chat <chat>",
          `only this chat; repeat for more; ${messenger.chatArgument}`,
          (value: string, previous: string[]) => [...previous, value],
          [],
        )
        .option("--since-time <time>", "include messages from this ISO timestamp with a time zone")
    command.action(async function (this: Command, directory: string) {
      const context = messengerContext(this, messenger)
      const environment = environmentOf<BaseEnvironment & { system?: ServerSystem }>(this)
      const signal = environment.commandSignal ?? environment.signal
      const system = environment.system ?? {
        ...thisMachine(),
        run: (args: string[], env: NodeJS.ProcessEnv) => runArchiveTimerCommand(args, env, signal),
      }
      const options = this.opts<{ at?: string; timezone?: string; chat?: string[]; sinceTime?: string }>()
      validateMediaSince(options.sinceTime)
      if (action === "install" && refusedPlace(directory, messenger.app, context.env))
        throw new CliError(
          "validation_error",
          "the archive cannot write credential, application or message-store folders",
        )
      // Canonicalize existing destinations so a symlink alias addresses the same timer.
      const root = await realpath(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
        return resolve(directory)
      })
      const plan = dailyArchiveTimer({
        app: messenger.app,
        profile: context.profile,
        directory: root,
        entry: system.entry,
        env: context.env,
        chats: options.chat,
        sinceTime: options.sinceTime,
        at: options.at,
        timeZone: options.timezone,
      })
      const result = await manageDailyArchiveTimer(
        plan,
        action,
        system,
        context.env,
        environment.commandSignal ?? environment.signal,
      )
      renderAnswer(this, context, itemOf(snakeKeys(result)), () => `${result.name}: ${action}\n`)
    })
  }
}
