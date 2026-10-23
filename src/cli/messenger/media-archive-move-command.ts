import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import { refusedPlace } from "../../sends/upload.js"
import { moveMediaArchive } from "../../services/media-archive-move.js"
import { environmentOf } from "../context.js"
import { LOCAL_WRITE } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"

export const addMediaArchiveMove = (attachments: Command, messenger: Messenger): void => {
  annotate(attachments.command("move"), {
    effects: LOCAL_WRITE,
    examples: [
      `${messenger.app.command} attachments move ./media-archive ./older-images --before-time 2026-10-01T00:00:00Z --dry-run`,
    ],
  })
    .description("move older images into another verified archive; remember their new locations")
    .argument("<dir>", "source media archive directory")
    .argument("<archive-dir>", "destination archive directory; created if needed")
    .requiredOption("--before-time <time>", "move images whose message date is before this ISO timestamp with zone")
    .option("--dry-run", "show counts and bytes without moving files or creating the destination")
    .addHelpText(
      "after",
      "\nCopies are verified at the destination before local image bytes are removed.\nSource manifests retain relocation records; checks follow them and downloads do not fetch them again.\nImages without a recorded message date are left in place and counted as undated.",
    )
    .action(async function (this: Command, directory: string, archiveDirectory: string) {
      const context = messengerContext(this, messenger)
      const options = this.opts<{ beforeTime: string; dryRun?: boolean }>()
      if (!options.dryRun) refuseLocalWrite(context, messenger.app.command, "attachments.move")
      if ([directory, archiveDirectory].some((folder) => refusedPlace(folder, messenger.app, context.env)))
        throw new CliError(
          "validation_error",
          "media archives cannot use credential, application or message-store folders",
        )
      const environment = environmentOf(this)
      const result = await moveMediaArchive({
        directory,
        archiveDirectory,
        beforeTime: options.beforeTime,
        dryRun: options.dryRun,
        signal: environment.commandSignal ?? environment.signal,
      })
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(result)),
        () =>
          `${result.dryRun ? `${result.selected} images selected (${result.selectedBytes} bytes)` : `${result.moved} images moved (${result.movedBytes} bytes)`}; ${result.undated} undated images left in place\n`,
      )
    })
}
