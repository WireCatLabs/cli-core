import { PassThrough } from "node:stream"
import { CliError, type RenderFormat } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { AGENTS, agentFor, screenFor } from "./setup-screen.js"

const contextFor = (format: RenderFormat) => {
  const diagnostic: string[] = []
  const notes: string[] = []
  return {
    diagnostic,
    notes,
    context: {
      format,
      streams: { diagnostic: (text: string) => void diagnostic.push(text) },
      renderer: { note: (text: string) => void notes.push(text) },
    },
  }
}

describe("screenFor", () => {
  it("prints numbered headings and indented details to stderr for a person", () => {
    const { context, diagnostic, notes } = contextFor("pretty")
    const screen = screenFor(context, false, 3)
    screen.step(2, "Connect")
    screen.detail("scan the code")
    screen.title("Done")
    expect(diagnostic).toEqual(["\n[2/3] Connect", "      scan the code", "Done"])
    expect(notes).toEqual([])
    expect(screen.indent).toBe(6)
  })

  it("hides everything from a person under --quiet", () => {
    const { context, diagnostic } = contextFor("pretty")
    const screen = screenFor(context, true, 3)
    screen.step(1, "Connect")
    screen.detail("x")
    screen.title("y")
    expect(diagnostic).toEqual([])
  })

  it("keeps plain notes in a machine mode, quiet or not", () => {
    const { context, diagnostic, notes } = contextFor("json")
    const screen = screenFor(context, true, 5)
    screen.step(1, "Connect")
    screen.detail("scan")
    screen.title("Done")
    expect(notes).toEqual(["1/5 — Connect", "scan", "Done"])
    expect(diagnostic).toEqual([])
    expect(screen.indent).toBe(0)
  })
})

describe("agentFor", () => {
  const terminal = (answer?: string) => {
    const input = Object.assign(new PassThrough(), { isTTY: true })
    if (answer !== undefined) input.end(`${answer}\n`)
    return { input, output: new PassThrough() }
  }

  it("returns the given agent without asking", async () => {
    const { input } = terminal()
    expect(await agentFor({ format: "pretty", stdin: input }, "codex", 0)).toBe("codex")
  })

  it.each([
    ["a machine mode", "json", true],
    ["a pipe", "pretty", false],
  ] as const)("answers none without asking in %s", async (_name, format, tty) => {
    const input = Object.assign(new PassThrough(), { isTTY: tty })
    expect(await agentFor({ format, stdin: input }, undefined, 0)).toBe("none")
  })

  it.each([
    ["Claude ", "claude"],
    ["", "none"],
  ])("reads %j at a terminal as %s", async (answer, expected) => {
    const { input, output } = terminal(answer)
    expect(await agentFor({ format: "pretty", stdin: input }, undefined, 2, { input, output })).toBe(expected)
  })

  it("refuses an unknown agent and names the choices", async () => {
    const { input, output } = terminal("vim")
    const failure = await agentFor({ format: "pretty", stdin: input }, undefined, 0, { input, output }).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(CliError)
    expect((failure as CliError).message).toContain(AGENTS.join(", "))
  })

  it("stops when the signal is already aborted", async () => {
    const { input, output } = terminal("claude")
    const signal = AbortSignal.abort()
    await expect(
      agentFor({ format: "pretty", stdin: input }, undefined, 0, { input, output, signal }),
    ).rejects.toMatchObject({
      code: "cancelled",
    })
  })
})
