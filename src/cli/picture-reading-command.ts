import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command, Option } from "commander"
import {
  PICTURE_AGENTS,
  PICTURE_MODEL,
  PICTURE_READING_MODES,
  type PictureAgent,
  type PictureReadingMode,
  type PictureReadingSetting,
  pictureExtractor,
  readPictureReading,
  writePictureReading,
} from "../attachments/picture-reading.js"
import type { AppIdentity } from "../ports/app.js"
import { agentOf } from "../runs/run-context.js"
import { environmentOf } from "./context.js"
import { grantsAuthority, LOCAL_READ, LOCAL_WRITE } from "./effects.js"
import { type Body, itemOf } from "./envelope.js"

export interface PictureReadingCommandOptions {
  env: () => NodeJS.ProcessEnv
  output: (answer: Body, command: Command) => void
  diagnostic: (line: string) => void
}

const TITLE: Record<PictureAgent, string> = { claude: "Claude Code", codex: "Codex" }

export const pictureReadingWarning = (agent: PictureAgent): string =>
  `a picture you ask to read is sent to ${TITLE[agent]} and from there to its provider, unless it runs a model on ` +
  "this computer; local only does not stop it"

const view = (setting: PictureReadingSetting) => ({
  mode: setting.mode,
  agent: setting.mode === "never" ? null : (setting.agent ?? null),
  model: setting.mode === "never" ? null : (setting.model ?? null),
  extractor: setting.mode === "never" || !setting.agent ? null : pictureExtractor(setting.agent, setting.model),
  since: setting.mode === "never" ? null : setting.at,
})

/** `models picture-reading`: whether the owner's coding agent may read a picture's text, and which agent. */
export const pictureReadingCommand = (app: AppIdentity, options: PictureReadingCommandOptions): Command => {
  const reading = annotate(new Command("picture-reading"), { effects: LOCAL_READ }).description(
    "let your coding agent read the text of a picture you choose: never (the default) or on request",
  )
  annotate(reading.command("show"), {
    effects: LOCAL_READ,
    output: { entity: "picture_reading" },
    examples: [`${app.command} models picture-reading show`],
  })
    .summary("whether pictures are read, and by which agent")
    .description("whether `images read` may give a picture to your coding agent, which one and with which model")
    .action(function (this: Command) {
      options.output(itemOf(view(readPictureReading(options.env()))), this)
    })
  grantsAuthority(
    annotate(reading.command("set"), {
      effects: LOCAL_WRITE,
      mcp: false,
      output: { entity: "picture_reading" },
      examples: [
        `${app.command} models picture-reading set request --agent claude`,
        `${app.command} models picture-reading set request --agent codex --model gpt-5`,
        `${app.command} models picture-reading set never`,
      ],
    }),
  )
    .description("never, or on request with `images read`; only you turn it on")
    .argument("<mode>", "never or request")
    .addOption(new Option("--agent <agent>", "the coding agent that reads: claude or codex").choices(PICTURE_AGENTS))
    .option("--model <model>", "the agent's model; its own default if not given")
    .option("--from-app", "you did this in WireCat Desktop")
    .action(function (this: Command, given: string) {
      if (!(PICTURE_READING_MODES as readonly string[]).includes(given))
        throw new CliError("validation_error", "say never or request")
      const mode = given as PictureReadingMode
      const { agent, model, fromApp } = this.opts<{ agent?: PictureAgent; model?: string; fromApp?: boolean }>()
      const env = options.env()
      const before = readPictureReading(env)
      if (mode === "never") {
        writePictureReading(env, { mode })
        options.output(itemOf({ ...view(readPictureReading(env)), changed: before.mode !== "never" }), this)
        return
      }
      // Turning it on sends pictures out of the store; an agent must not decide that for the owner.
      if ((environmentOf(this).agent || agentOf(env)) && !fromApp)
        throw new CliError("permission_error", "only the owner turns picture reading on, not an agent", {
          reason: "picture-reading.owner-only",
        })
      const chosen = agent ?? (before.mode === "request" ? before.agent : undefined)
      if (!chosen)
        throw new CliError("validation_error", "choose the agent that reads: --agent claude or --agent codex", {
          reason: "picture-reading.agent-missing",
        })
      if (model !== undefined && !PICTURE_MODEL.test(model))
        throw new CliError("validation_error", "a model name is letters, digits and . _ : / -, at most 100")
      // A new agent does not inherit the old agent's model.
      const kept = model ?? (chosen === before.agent ? before.model : undefined)
      writePictureReading(env, { mode, agent: chosen, ...(kept ? { model: kept } : {}) })
      const now = readPictureReading(env)
      options.diagnostic(pictureReadingWarning(chosen))
      options.output(
        itemOf({
          ...view(now),
          changed: before.mode !== now.mode || before.agent !== now.agent || before.model !== now.model,
        }),
        this,
      )
    })
  return reading
}
