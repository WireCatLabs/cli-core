import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { sendTime } from "../../domain/send-time.js"
import { threadIdOf } from "../../domain/thread.js"
import { typedSendAs } from "../../sends/send-as.js"
import { readAttachments, readStickerFile } from "../../sends/upload.js"
import { ownerOnlyOption, REMOTE_WRITE } from "../effects.js"
import { renderAnswer } from "../envelope.js"
import { type Messenger, messengerContext } from "./context.js"
import { afterWrite, writtenAnswer } from "./message-writes.js"
import { readAll } from "./stdin.js"

/**
 * **Asked before it goes, told after, on every outcome** — the guard's journal is the only record
 * of what this profile tried to send, and it never holds the text.
 */
export const HTML_HELP = "the text is HTML: <b>, <i>, <a href>, <code>"

export const sendCommand = (messenger: Messenger): Command => {
  const send = annotate(new Command("send"), {
    examples: [`${messenger.app.command} personal messages send "Book club" "The meeting starts at 10."`],
    effects: REMOTE_WRITE,
  })
    .description("send a text message; without [text], the text is read from stdin")
    .argument("<chat>", messenger.chatArgument)
    .argument("[text]", "the message")
  // Offered only where the messenger has them, so a CLI never shows a flag it would refuse.
  if (messenger.topics !== false) send.option("--topic <id>", "send to this forum topic")
  send.option("--reply-to <message>", "answer this message, by its id in the same chat")
  if (messenger.channelComments !== false)
    send.option("--comment-to <post>", "comment on this post of the channel; it goes to the post's discussion group")
  if (messenger.sendAs !== false)
    send.option(
      "--send-as <id>",
      "post as one of the identities `chats send-as` lists; required where the chat posts as someone else by default",
    )
  send.option("--operation-id <id>", "repeat a send whose outcome was unknown, without risking a second copy")
  if (messenger.silentSends !== false) send.option("--silent", "deliver without a notification")
  send
    .option("--no-preview", "no preview card for a link in the text")
    .option("--md", "read this messenger's Markdown; see its formatting guide for supported syntax")
    .option("--file <file>", "attach a file; the text becomes its caption")
    .option("--photo <file>", "attach a .jpg, .png or .webp as a photo; the text becomes its caption")
    .option("--as-file", "send the --file as a file to download, a video included")
    .option("--voice <file>", "send an Ogg Opus file as a voice message, alone, with no text")
    .addOption(
      ownerOnlyOption("--allow-any-file", "send a file even from credential folders or this CLI's own folders"),
    )
  if (messenger.scheduledSends !== false)
    send.option(
      "--at-time <time>",
      "let the messenger send it later, even with this machine off: 2026-09-25T09:00 (local time), or 30m, 2h, 1d from now",
    )
  send.action(async function (this: Command, chat: string, text: string | undefined) {
    await sendText(this, messenger, chat, text)
  })
  if (messenger.mediaOptions?.includes("spoiler"))
    send.option("--spoiler", "hide the --photo or video behind a spoiler until tapped")
  if (messenger.mediaOptions?.includes("captionAbove"))
    send.option("--caption-above", "show the text above the --photo or --file, not below it")
  if (messenger.mediaOptions?.includes("fileName"))
    send.option("--filename <name>", "the name others see for the --file, instead of its name on disk")
  if (messenger.html) send.option("--html", HTML_HELP)
  if (messenger.stickers === true)
    send.option("--sticker <id>", "send this sticker, alone; `stickers list` finds its id")
  if (messenger.stickerFileBytes !== undefined)
    send.option("--sticker-file <file>", "send a .webp file as a sticker, alone, with no text")
  return send
}

const sendText = async (command: Command, messenger: Messenger, chat: string, text: string | undefined) => {
  const context = messengerContext(command, messenger)
  const {
    topic,
    replyTo: typedReplyTo,
    commentTo: typedCommentTo,
    sendAs: givenSendAs,
    operationId: sendId,
    silent,
    preview,
    md: markdown,
    html,
    atTime: at,
    file,
    photo,
    voice,
    asFile,
    filename,
    allowAnyFile,
    spoiler,
    captionAbove,
    sticker,
    stickerFile,
  } = command.opts<{
    topic?: string
    replyTo?: string
    commentTo?: string
    sendAs?: string
    operationId?: string
    silent?: boolean
    preview?: boolean
    md?: boolean
    html?: boolean
    atTime?: string
    file?: string
    photo?: string
    voice?: string
    asFile?: boolean
    filename?: string
    allowAnyFile?: boolean
    spoiler?: boolean
    captionAbove?: boolean
    sticker?: string
    stickerFile?: string
  }>()
  const threadId = threadIdOf(topic)
  const scheduledFor = at === undefined ? undefined : sendTime(at)
  const replyTo = typedReplyTo?.trim()
  if (replyTo === "") throw new CliError("validation_error", "--reply-to needs the id of the message to answer")
  const sendAs = typedSendAs(givenSendAs)
  const commentTo = typedCommentTo?.trim()
  if (commentTo === "") throw new CliError("validation_error", "--comment-to needs the post's message id")
  const read = { app: messenger.app, env: context.env, anyFile: allowAnyFile === true }
  const attachments = await readAttachments(
    {
      ...(photo === undefined ? {} : { photo }),
      ...(file === undefined ? {} : { file }),
      ...(voice === undefined ? {} : { voice }),
      ...(text === undefined ? {} : { text }),
      asFile: asFile === true,
      ...(filename === undefined ? {} : { filename }),
    },
    read,
  )
  const stickerUpload =
    stickerFile === undefined || messenger.stickerFileBytes === undefined
      ? undefined
      : await readStickerFile(stickerFile, messenger.stickerFileBytes, read)
  const alone = sticker !== undefined || stickerUpload !== undefined
  const body = text ?? (attachments.length > 0 || alone ? "" : await readAll(context.stdin))
  if (body.trim() === "" && attachments.length === 0 && !alone) {
    throw new CliError("validation_error", "nothing to send — give the text or pipe it in")
  }
  const { sent, reader } = await context.withServices(async (services) => {
    const sent = await services.messages.send({
      chat,
      text: body,
      ...(sendId === undefined ? {} : { sendId }),
      ...(replyTo === undefined ? {} : { replyTo }),
      ...(commentTo === undefined ? {} : { commentTo }),
      ...(threadId === undefined ? {} : { threadId }),
      ...(sendAs === undefined ? {} : { sendAs }),
      ...(silent === true ? { silent } : {}),
      ...(preview === false ? { noPreview: true } : {}),
      ...(markdown === true ? { markdown } : {}),
      ...(html === true ? { html } : {}),
      ...(scheduledFor === undefined ? {} : { at: scheduledFor }),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(spoiler === true ? { spoiler } : {}),
      ...(captionAbove === true ? { captionAbove } : {}),
      ...(sticker === undefined ? {} : { sticker }),
      ...(stickerUpload === undefined ? {} : { stickerFile: stickerUpload }),
    })
    return afterWrite(sent, async () => ({ sent, reader: await services.messages.reader() }))
  })
  await afterWrite(sent, () =>
    renderAnswer(
      command,
      context,
      writtenAnswer({ ...sent, ...(scheduledFor === undefined ? {} : { scheduledFor }) }, reader),
    ),
  )
}
