import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import { parseDuration } from "../../domain/duration.js"
import { refusedPlace } from "../../sends/upload.js"
import { FETCHING } from "../../services/archive.js"
import { archiveMedia, checkMediaArchive, validateMediaSince } from "../../services/media-archive.js"
import { environmentOf, setExitCode } from "../context.js"
import { FETCH, LOCAL_READ } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { type Messenger, messengerContext } from "./context.js"
import { addMediaArchiveTimers } from "./media-archive-timer-command.js"
import { stopOnSignal } from "./patience.js"

export const addMediaArchiveCommands = (archive: Command, messenger: Messenger): void => {
  annotate(archive.command("download"), {
    effects: FETCH,
    examples: [`${messenger.app.command} attachments download ./media-archive`],
  })
    .description("archive media from selected chats; verify and keep existing copies")
    .addHelpText(
      "after",
      `\nMedia is saved only when you request a download; serve does not save these copies.\nTo disable an installed daily backup: ${messenger.app.command} <profile> attachments jobs stop <dir>.`,
    )
    .argument("<dir>", "archive directory; created if missing")
    .option(
      "--chat <chat>",
      `only this chat; repeat for more; ${messenger.chatArgument}`,
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--since-time <time>", "include messages from this ISO timestamp with a time zone")
    .option("--pause <duration>", "pause between history pages", messenger.fetching?.pause ?? FETCHING.pause)
    .action(async function (this: Command, directory: string) {
      const context = messengerContext(this, messenger)
      const options = this.opts<{ chat?: string[]; sinceTime?: string; pause: string }>()
      validateMediaSince(options.sinceTime)
      const pauseMs = parseDuration(options.pause, "--pause")
      if (context.settings.offline) throw new CliError("validation_error", "archiving media needs online mode")
      if (refusedPlace(directory, messenger.app, context.env))
        throw new CliError(
          "validation_error",
          "the archive cannot write credential, application or message-store folders",
        )
      const stop = stopOnSignal(this)
      const environment = environmentOf(this)
      const signal = AbortSignal.any([
        stop.signal,
        ...[environment.signal, environment.commandSignal].filter((one): one is AbortSignal => one !== undefined),
      ])
      try {
        const result = await context.withServices((services) =>
          archiveMedia(services, {
            directory,
            chats: options.chat,
            sinceTime: options.sinceTime,
            pauseMs,
            signal,
            pageSize: messenger.history === "store" ? 100 : (messenger.fetching ?? FETCHING).page,
            orderByTime: messenger.history !== "store" && messenger.fetching?.orderBy === "time",
          }),
        )
        renderAnswer(
          this,
          context,
          itemOf(snakeKeys(result)),
          () => `${result.saved} saved, ${result.existing} verified copies already present; ${result.chats} chats\n`,
        )
      } finally {
        stop.release()
      }
    })
  annotate(archive.command("check"), {
    effects: LOCAL_READ,
    examples: [`${messenger.app.command} attachments check ./media-archive`],
  })
    .description("rehash all archived files without connecting to the messenger")
    .argument("<dir>", "archive directory")
    .action(async function (this: Command, directory: string) {
      const context = messengerContext(this, messenger)
      const environment = environmentOf(this)
      const result = await checkMediaArchive(directory, environment.commandSignal ?? environment.signal)
      if (!result.valid) setExitCode(this, 1)
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(result)),
        () =>
          `${result.checked} files checked; ${result.files.filter((one) => !one.valid).length} missing or changed\n`,
      )
    })
  addMediaArchiveTimers(archive, messenger)
}
