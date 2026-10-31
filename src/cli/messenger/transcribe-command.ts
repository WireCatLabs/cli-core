import { annotate } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import type { RemoteFile } from "../../ports/messenger.js"
import { type Kept, openKept } from "../../speech/hearing.js"
import { isInstalled } from "../../speech/install.js"
import {
  choose,
  type Heard,
  heardVia,
  hearLocally,
  hearOnline,
  keptSource,
  notDownloaded,
} from "../../speech/transcribe.js"
import { REMOTE_READ } from "../effects.js"
import { renderAnswer } from "../envelope.js"
import { type Messenger, messengerContext } from "./context.js"
import { heardAnswer } from "./message-answers.js"
import { keepRefreshedRefs } from "./refreshed-refs.js"

/** `messages transcribe`: a voice message as text, by the messenger or by a model on this machine. */
export const transcribeSubcommand = (messages: Command, messenger: Messenger): Command =>
  annotate(messages.command("transcribe"), {
    output: { entity: "message_transcript" },
    examples: [`${messenger.app.command} personal messages transcribe "Book club" 101`],
    effects: REMOTE_READ,
  })
    .summary("transcribe one voice message")
    .description(
      `a voice message as text — by ${messenger.name ?? messenger.app.command} where it can, else by a model on this machine`,
    )
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the id of a voice message")
    .option("--local", "use the model on this machine, never the messenger")
    .option("--model <model>", "which downloaded model; implies --local (`models list`)")
    .action(async function (this: Command, chat: string, messageId: string) {
      const context = messengerContext(this, messenger)
      const choice = {
        ...choose(
          messenger,
          context.settings,
          this.opts<{ local?: boolean; model?: string }>(),
          context.env,
          context.keyring,
        ),
        ...(context.recognizer ? { open: context.recognizer } : {}),
      }
      // Before connecting: a missing model or OpenAI key should not cost a login.
      if (choice.refusal) throw choice.refusal
      if (choice.with === "local" && !isInstalled(choice.model, choice.directory)) {
        throw notDownloaded(messenger, choice.model)
      }
      const id = messageId.trim()
      // Opened once connected: a profile's first connection is what names the account its transcripts belong to.
      const withKept = async <T>(work: (kept: Kept) => Promise<T>) => {
        const kept = await openKept(messenger, context.profile, context.env)
        try {
          return await work(kept)
        } finally {
          await kept.close()
        }
      }
      const [chatId, before, online] = await context.withMessenger(async (connection) => {
        const { id: resolved } = await connection.resolve(chat)
        const before = await withKept((kept) => kept.get({ chatId: resolved, messageId: id }))
        // Asking for a local model other than the one that heard it is asking to hear it again.
        if (before && !(choice.with === "local" && before.source !== choice.model.id)) {
          return [resolved, before, undefined] as const
        }
        const read = (file: RemoteFile) =>
          keepRefreshedRefs(messenger, context, resolved, id, [file], context.renderer.warn)
        return [resolved, undefined, await hearOnline(messenger, connection, resolved, id, choice, read)] as const
      })
      const heard: Heard = before
        ? { messageId: id, text: before.text, pending: false, ...heardVia(before.source, messenger.provider) }
        : online instanceof Uint8Array
          ? await hearLocally(online, id, choice)
          : (online as Heard)
      if (!heard.pending && !before) {
        await withKept((kept) => kept.keep({ chatId, messageId: id }, heard.text, keptSource(heard)))
      }
      renderAnswer(this, context, heardAnswer(heard, chatId), () => `${heard.text}\n`)
    })
