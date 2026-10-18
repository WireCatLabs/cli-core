import * as v from "valibot"
import type { Messenger } from "../cli/messenger/context.js"
import type { AnyTool } from "./tool.js"
import { attachmentsTools } from "./tools/attachments.js"
import { messagesPhotoTools } from "./tools/messages-photo.js"
import { statsTools } from "./tools/stats.js"

/**
 * The answers a command cannot give: a picture or a file handed to the model as MCP image or resource content.
 * Every other tool is the command itself (`toolsFromCommands`); one of these takes its command's place.
 */
export const pictureTools = (messenger: Messenger): Record<string, AnyTool> =>
  Object.fromEntries(
    Object.entries({
      ...messagesPhotoTools(messenger),
      ...attachmentsTools(messenger),
      ...statsTools(messenger),
    }).map(([name, definition]) => [name, { ...definition, input: v.strictObject(definition.input.entries) }]),
  )
