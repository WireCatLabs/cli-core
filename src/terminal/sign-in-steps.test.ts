import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { CliError, captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { recordRuns } from "../cli/command-runs.js"
import { answerStdinOption, signInSteps } from "./sign-in-steps.js"

const steps = (options: { json?: boolean; answers?: boolean } = {}) => {
  const lines: string[] = []
  const input = new PassThrough()
  const made = signInSteps({
    diagnostic: (line) => lines.push(line),
    json: options.json ?? true,
    answers: options.answers ?? true,
    input,
  })
  return { made, lines, input, events: () => lines.map((line) => JSON.parse(line)) }
}

const PASSWORD = { field: "password", secret: true, prompt: "2FA password" }

describe("signInSteps", () => {
  it("prints each step as one JSON line", () => {
    const { made, events } = steps({ answers: false })
    made.openUrl("https://example.test/approve", "approve access")
    made.pairingCode("ABCD-EFGH", "on the phone", new Date("2026-10-26T12:00:00Z"))
    made.progress("history", "receiving history")
    expect(events()).toEqual([
      { event: "open_url", url: "https://example.test/approve", purpose: "approve access" },
      { event: "pairing_code", code: "ABCD-EFGH", where: "on the phone", expires_at: "2026-10-26T12:00:00.000Z" },
      { event: "progress", step: "history", message: "receiving history" },
    ])
  })

  it("prints nothing for people reading a terminal", () => {
    const { made, lines } = steps({ json: false, answers: false })
    made.openUrl("https://example.test/approve", "approve access")
    made.progress("history", "receiving history")
    expect(lines).toEqual([])
  })

  it("asks one question per line and reads two answers that came in one write, in order", async () => {
    const { made, events, input } = steps()
    input.write("+15550000000\n12345\n")
    expect(await made.ask({ field: "phone", secret: false, prompt: "phone number" })).toBe("+15550000000")
    expect(await made.ask({ field: "code", secret: false, prompt: "login code", hint: "sent in Telegram" })).toBe(
      "12345",
    )
    expect(events()).toEqual([
      { event: "needs", field: "phone", secret: false, prompt: "phone number", hint: null },
      { event: "needs", field: "code", secret: false, prompt: "login code", hint: "sent in Telegram" },
    ])
  })

  it("waits for an answer typed later, and keeps the input open and paused after it", async () => {
    const { made, input } = steps()
    const answer = made.ask(PASSWORD)
    input.write("not-a-real-")
    input.write("password\r\n")
    expect(await answer).toBe("not-a-real-password")
    expect(input.isPaused()).toBe(true)
    expect(input.readableEnded).toBe(false)
  })

  it("never prints the answer", async () => {
    const { made, lines, input } = steps()
    input.write("s3cret-answer\n")
    await made.ask(PASSWORD)
    made.progress("login", "logging in")
    expect(lines.join("\n")).not.toContain("s3cret-answer")
  })

  it("withdraws a question when its signal aborts, and the next question gets the next line", async () => {
    const { made, input } = steps()
    const controller = new AbortController()
    const withdrawn = made.ask({ field: "redirect", secret: true, prompt: "the address" }, controller.signal)
    controller.abort(new CliError("cancelled", "the browser answered"))
    await expect(withdrawn).rejects.toThrow("the browser answered")
    input.write("later\n")
    expect(await made.ask(PASSWORD)).toBe("later")
  })

  it("fails a question when the input closes before its answer", async () => {
    const { made, input } = steps()
    const answer = made.ask(PASSWORD)
    input.end()
    await expect(answer).rejects.toMatchObject({ code: "cancelled", details: { reason: "input.closed" } })
  })

  it("refuses to read without --answer-stdin, and --answer-stdin without --json", async () => {
    const { made, lines } = steps({ answers: false })
    await expect(made.ask(PASSWORD)).rejects.toMatchObject({ details: { reason: "input.required" } })
    expect(lines).toEqual([])
    expect(() => steps({ json: false, answers: true })).toThrow("--answer-stdin needs --json")
  })
})

describe("an answer read from stdin", () => {
  const filesUnder = (dir: string): string[] =>
    readdirSync(dir, { recursive: true })
      .map((one) => join(dir, String(one)))
      .filter((path) => statSync(path).isFile())

  it.each([
    ["kept by --record", false],
    ["kept because the run failed", true],
  ])("stays out of the run record %s", async (_, fails) => {
    const state = mkdtempSync(join(tmpdir(), "sign-in-steps-"))
    const env = { APP_STATE_DIR: state }
    const input = new PassThrough()
    const program = new Command("app").exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} })
    program.option("--json")
    program
      .command("login")
      .addOption(answerStdinOption())
      .action(async (options: { answerStdin?: boolean }) => {
        const made = signInSteps({ diagnostic: () => {}, json: true, answers: options.answerStdin === true, input })
        const answer = await made.ask(PASSWORD)
        if (fails) throw new CliError("authentication_error", "the password was not accepted")
        expect(answer).toBe("s3cret-answer")
      })
    recordRuns(program, {
      app: { command: "app", appName: "app-cli", envPrefix: "APP", description: "A test CLI", version: "1.2.3" },
      settings: () => ({}),
      env,
      streams: captureStreams(),
    })
    input.write("s3cret-answer\n")
    await program.parseAsync(["--json", "login", "--answer-stdin", "--record"], { from: "user" }).catch(() => {})

    const files = filesUnder(state)
    expect(files.some((path) => path.endsWith("index.jsonl"))).toBe(true)
    for (const path of files) expect(readFileSync(path, "utf8"), path).not.toContain("s3cret-answer")
  })
})
