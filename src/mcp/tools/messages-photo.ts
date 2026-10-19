import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { itemOf } from "../../cli/envelope.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { keepRefreshedRefs } from "../../cli/messenger/refreshed-refs.js"
import { capability, type RemoteFile } from "../../ports/messenger.js"
import { typedCommand } from "../../runs/scope.js"
import { type AnyTool, chatOf, message, Picture, READ, tool } from "../tool.js"

/** Larger than this and a client may refuse the answer, or spend the model's context on one picture. */
export const PHOTO_LIMIT = 512 * 1024

const IMAGE_TYPES: [string, (bytes: Uint8Array) => boolean][] = [
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/png", (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ["image/webp", (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP"],
]
const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))

export const messagesPhotoTools = (messenger: Messenger): Record<string, AnyTool> => ({
  messages_photo: tool({
    title: "Look at a photo",
    agentOnly: true,
    description:
      `A message's photo, as an image to look at. Up to ${PHOTO_LIMIT / 1024} KB; anything larger, and ` +
      "files, videos and voice messages, are refused with the command the owner runs to save them.",
    input: v.object({
      chat: chatOf(messenger),
      message,
      index: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(0),
          v.description("attachment index from 0; omit for the first photo"),
        ),
      ),
    }),
    annotations: READ,
    online: async (adapter, args, defaults) => {
      const { id: chatId } = await adapter.resolve(args.chat)
      const saveIt = `the owner can save it with \`${typedCommand(messenger.app.command, `messages download ${chatId} ${args.message}`)}\``
      const { files } = await capability(adapter, "download", "download attachments")(chatId, args.message)
      const photo = args.index === undefined ? files.find((file) => file.kind === "photo") : files[args.index]
      if (!photo) {
        const kinds = files.map((file) => file.kind).join(", ")
        throw new CliError(
          files.length === 0 ? "not_found" : "validation_error",
          files.length === 0
            ? `message ${args.message} has no photo`
            : `the message has a ${kinds}, not a photo — ${saveIt}`,
        )
      }
      if (photo.kind !== "photo")
        throw new CliError("validation_error", `the selected attachment is not a photo — ${saveIt}`)
      const bytes = await readUpTo(photo, PHOTO_LIMIT, saveIt)
      await keepRefreshedRefs(
        messenger,
        { profile: defaults.settings.profile, env: defaults.env },
        chatId,
        args.message,
        [photo],
      )
      const mimeType = IMAGE_TYPES.find(([, is]) => is(bytes))?.[0]
      if (!mimeType) throw new CliError("validation_error", `the photo is not JPEG, PNG or WebP — ${saveIt}`)
      return new Picture(bytes, mimeType, itemOf({ chat_id: chatId, message_id: args.message, bytes: bytes.length }))
    },
  }),
})

/** Stops reading at the limit: a photo larger than it is refused, not fetched whole. */
const readUpTo = async (file: RemoteFile, limit: number, saveIt: string): Promise<Uint8Array> => {
  const tooLarge = () => new CliError("validation_error", `the photo is larger than ${limit / 1024} KB — ${saveIt}`)
  if ((file.size ?? 0) > limit) throw tooLarge()
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of file.bytes()) {
    total += chunk.length
    if (total > limit) throw tooLarge()
    chunks.push(chunk)
  }
  return new Uint8Array(Buffer.concat(chunks))
}
