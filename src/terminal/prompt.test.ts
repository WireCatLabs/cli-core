import { PassThrough, Readable } from "node:stream"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { secretInputOf } from "../cli/context.js"
import { run } from "../cli/program.js"
import { readSecret } from "./prompt.js"

const terminal = () => Object.assign(new PassThrough(), { isTTY: true })
const collected = () => {
  const output = new PassThrough()
  const chunks: string[] = []
  output.on("data", (chunk: Buffer) => chunks.push(chunk.toString()))
  return { output, text: () => chunks.join("") }
}

describe("readSecret", () => {
  it("reads a piped secret whole and trimmed, with no prompt", async () => {
    const { output, text } = collected()
    expect(await readSecret("token: ", { input: Readable.from(["abc", "def\n"]), output })).toBe("abcdef")
    expect(text()).toBe("")
  })

  it("**never echoes what is typed at a terminal**, but shows the prompt", async () => {
    const input = terminal()
    const { output, text } = collected()
    const answer = readSecret("token: ", { input, output })
    input.write("s3cret\n")

    expect(await answer).toBe("s3cret")
    expect(text()).toContain("token: ")
    expect(text()).not.toContain("s3cret")
  })

  it("echoes when asked to, for a code a person has to see", async () => {
    const input = terminal()
    const { output, text } = collected()
    const answer = readSecret("code: ", { input, output, echo: true })
    input.write("12345\n")

    expect(await answer).toBe("12345")
    expect(text()).toContain("12345")
  })

  it("is cancelled, not left waiting, when the terminal closes", async () => {
    const input = terminal()
    const answer = readSecret("token: ", { input, output: collected().output })
    input.end()

    await expect(answer).rejects.toMatchObject({ code: "cancelled" })
  })

  it.each([true, false])("aborts pending input (terminal: %s) without ending the caller's stream", async (isTTY) => {
    const input = Object.assign(new PassThrough(), { isTTY })
    const controller = new AbortController()
    const answer = readSecret("token: ", { input, output: collected().output, signal: controller.signal })
    controller.abort()
    await expect(answer).rejects.toMatchObject({ code: "cancelled" })
    expect(input.destroyed).toBe(false)
    if (!isTTY) expect(input.listenerCount("data")).toBe(0)
    expect(input.listenerCount("end")).toBe(0)
    const next = readSecret("code: ", { input, output: collected().output })
    if (isTTY) input.write("next\n")
    else input.end("next\n")
    expect(await next).toBe("next")
  })

  it("refuses a signal already aborted without showing a prompt", async () => {
    const controller = new AbortController()
    controller.abort()
    const { output, text } = collected()
    await expect(readSecret("token: ", { input: terminal(), output, signal: controller.signal })).rejects.toMatchObject(
      { code: "cancelled" },
    )
    expect(text()).toBe("")
  })

  it("collects a piped secret with cancellation enabled", async () => {
    expect(
      await readSecret("token: ", { input: Readable.from(["abc", "def\n"]), signal: new AbortController().signal }),
    ).toBe("abcdef")
  })

  it("reports a piped stream failure and releases the abort listener", async () => {
    const input = new PassThrough()
    const answer = readSecret("token: ", { input, signal: new AbortController().signal })
    input.destroy(new Error("synthetic input failure"))
    await expect(answer).rejects.toThrow("synthetic input failure")
    expect(input.listenerCount("data")).toBe(0)
  })
})

describe("secretInputOf", () => {
  it("prompts on the run's own input and output, not the process's", async () => {
    const input = terminal()
    const { output, text } = collected()
    let answer = ""
    const running = run(
      ["session", "start"],
      {
        app: { command: "app", appName: "app-cli", envPrefix: "APP", description: "A test CLI", version: "1.0.0" },
        commands: () => [
          new Command("session").addCommand(
            new Command("start").action(async function (this: Command) {
              answer = await readSecret("phone: ", { ...secretInputOf(this), echo: true })
            }),
          ),
        ],
      },
      { streams: captureStreams(), stdin: input, stderr: output, tty: true, env: {} },
    )
    setImmediate(() => input.write("+34600000000\n"))

    expect(await running).toBe(0)
    expect(answer).toBe("+34600000000")
    expect(text()).toContain("phone: ")
  })
})
