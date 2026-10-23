import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams, errorObjectOf } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command, Option } from "commander"
import { describe, expect, it } from "vitest"
import { failureContext } from "../errors/reasons.js"
import { showInputFields } from "./input-fields.js"
import { run } from "./program.js"

const command = () => new Command("update").option("--first-name <name>").option("--last-name <name>")
const failure = (fields: unknown, reason = "input.field-conflict") =>
  new CliError("validation_error", "a last name needs a first name", { reason, fields })

describe("input field errors at the CLI boundary", () => {
  it("names declared flags without changing the adapter's error", () => {
    const source = failure(["lastName", "firstName"])
    const answer = errorObjectOf(source, failureContext())
    showInputFields(answer, command())
    expect(answer.error).toMatchObject({
      reason: "input.field-conflict",
      param: "--last-name",
      message: "--last-name, --first-name: a last name needs a first name",
      details: { fields: ["--last-name", "--first-name"] },
    })
    expect(source.details.fields).toEqual(["lastName", "firstName"])
    showInputFields(answer, command())
    expect(answer.error.message).toBe("--last-name, --first-name: a last name needs a first name")
  })

  it("finds inherited options and omits hidden aliases", () => {
    const root = new Command("tool").option("--first-name <name>")
    const child = root.addCommand(
      new Command("update").option("--last-name <name>").addOption(new Option("--firstName <name>").hideHelp()),
    ).commands[0]
    if (!child) throw new Error("missing synthetic command")
    const answer = errorObjectOf(failure(["firstName"], "input.field-unsupported"), failureContext())
    showInputFields(answer, child)
    expect(answer.error.param).toBe("--first-name")
  })

  it.each([[], ["missing"], ["firstName", "missing"], [3], null])("does not guess a flag for %j", (fields) => {
    const answer = errorObjectOf(failure(fields), failureContext())
    const before = structuredClone(answer)
    showInputFields(answer, command())
    expect(answer).toEqual(before)
  })

  it("keeps unrelated reasons unchanged", () => {
    const answer = errorObjectOf(failure(["firstName"], "input.required"), failureContext())
    const before = structuredClone(answer)
    showInputFields(answer, command())
    expect(answer).toEqual(before)
  })

  it("formats a command failure in the actual runner", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "field-error-"))
    const streams = captureStreams()
    const change = annotate(
      command().action(() => {
        throw failure(["lastName", "firstName"])
      }),
      {
        effects: { remote: "none", local: "none" },
      },
    )
    const app = {
      command: "fieldtest",
      appName: "field-test",
      envPrefix: "FIELDTEST",
      version: "1.0.0",
      description: "Synthetic",
    }
    const code = await run(
      ["update", "--last-name", "Synthetic", "--json"],
      { app, commands: () => [change] },
      {
        streams,
        tty: false,
        env: {
          FIELDTEST_CONFIG_DIR: join(scratch, "config"),
          FIELDTEST_STATE_DIR: join(scratch, "state"),
          FIELDTEST_CACHE_DIR: join(scratch, "cache"),
          MESSAGING_STORE: join(scratch, "store.sqlite"),
        },
      },
    )
    expect(code).toBe(2)
    expect(streams.stdout).toEqual([])
    expect(JSON.parse(streams.stderr[0] ?? "").error).toMatchObject({
      reason: "input.field-conflict",
      param: "--last-name",
      details: { fields: ["--last-name", "--first-name"] },
    })
  })
})
