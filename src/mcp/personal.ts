import * as v from "valibot"
import type { Messenger } from "../cli/messenger/context.js"
import type { AnyTool } from "./tool.js"
import { deleteTools, localTools, markReadTools, readTools, sendTools } from "./tools.js"

/** The same definitions a built-in server mounts, for a host retaining its own session and guards. */
export const personalMcpTools = (messenger: Messenger): Record<string, AnyTool> =>
  Object.fromEntries(
    Object.entries({
      ...readTools(messenger),
      ...localTools(messenger),
      ...sendTools(messenger),
      ...markReadTools(messenger),
      ...deleteTools(messenger),
    }).map(([name, definition]) => [
      name,
      {
        ...definition,
        // An obsolete scheduling argument must fail, not silently turn into an immediate send.
        input: v.strictObject(definition.input.entries),
      },
    ]),
  )

export { warmEmbedders } from "../embeddings/embed.js"
export { commandOf as personalMcpCommand, registerSurface as registerPersonalMcpSurface } from "./surface.js"
export {
  type AnyTool as PersonalMcpTool,
  answered as answerMcpTool,
  BinaryResource as McpBinaryResource,
  type Defaults as PersonalMcpDefaults,
  failed as failMcpTool,
  Picture as McpPicture,
  type Registration as PersonalMcpRegistration,
  registerTools as registerPersonalMcpTools,
  toolKey as personalMcpToolKey,
} from "./tool.js"
