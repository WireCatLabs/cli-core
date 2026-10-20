import { CliError, indent, type Renderer, type RenderFormat, type Streams } from "@wirecat/cli-base"
import { readSecret, type SecretInput } from "../terminal/prompt.js"
import { inputPolicy } from "./input-policy.js"

export const AGENTS = ["none", "codex", "cursor", "claude", "gemini", "all"] as const
export type Agent = (typeof AGENTS)[number]

const DETAIL = 6

/**
 * A person sees each step as a heading with its details indented under it. `--quiet` hides both, as it
 * hides notes; a machine mode keeps the plain notes it always had, since stderr there is a log.
 */
export const screenFor = (
  context: { format: RenderFormat; streams: Pick<Streams, "diagnostic">; renderer: Pick<Renderer, "note"> },
  quiet: boolean,
  steps: number,
) => {
  const person = context.format === "pretty"
  const say = (text: string) => {
    if (!quiet) context.streams.diagnostic(text)
  }
  return {
    step: (index: number, title: string) =>
      person ? say(`\n[${index}/${steps}] ${title}`) : context.renderer.note(`${index}/${steps} — ${title}`),
    detail: (text: string) => (person ? say(indent(text, DETAIL)) : context.renderer.note(text)),
    title: (text: string) => (person ? say(text) : context.renderer.note(text)),
    indent: person ? DETAIL : 0,
  }
}

/** Asks only a person at a terminal; every other run gets "none", so no agent is ever installed unasked. */
export const agentFor = async (
  context: { format: RenderFormat; stdin: NodeJS.ReadableStream & { isTTY?: boolean } },
  given: Agent | undefined,
  pad: number,
  prompt: Pick<SecretInput, "input" | "output" | "signal"> = {},
): Promise<Agent> => {
  if (given) return given
  if (context.format !== "pretty" || !context.stdin.isTTY || inputPolicy(context.stdin).noInput) return "none"
  const answer =
    (
      await readSecret(`${" ".repeat(pad)}Agent [codex/cursor/claude/gemini/all/none] (none): `, {
        ...prompt,
        echo: true,
      })
    )
      .trim()
      .toLowerCase() || "none"
  const agent = AGENTS.find((known) => known === answer)
  if (agent === undefined)
    throw new CliError("validation_error", `unknown agent — choose ${AGENTS.join(", ")} with --agent`)
  return agent
}
