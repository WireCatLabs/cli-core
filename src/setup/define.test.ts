import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { settingsFor } from "../cli/settings.js"
import { defineSetup, type SetupDefinition } from "./define.js"
import { setupFileProblems } from "./files.js"

const app = { command: "demo", appName: "demo-cli", envPrefix: "DEMO", description: "A test", version: "1.2.3" }
const configuration = settingsFor(app, { profile: { host: v.optional(v.string()), port: v.optional(v.number()) } })

const flow = (): SetupDefinition => ({
  app,
  configuration,
  start: "server",
  steps: {
    server: {
      title: "server.title",
      blocks: [
        { type: "input", id: "host", setting: "host", input: "text", label: "server.host" },
        { type: "input", id: "password", secret: "token", input: "password", label: "server.password" },
      ],
      next: "check",
    },
    check: {
      kind: "run",
      title: "check.title",
      action: "apply",
      next: [{ when: { result: "check", is: "ok" }, to: "done" }, { to: "server" }],
    },
    done: { kind: "done", title: "done.title" },
  },
  texts: {
    en: {
      "server.title": "Server",
      "server.host": "Host",
      "server.password": "Password",
      "check.title": "Checking",
      "done.title": "Done",
    },
  },
})

const problemsOf = (change: (definition: SetupDefinition) => void): string => {
  const definition = flow()
  change(definition)
  try {
    defineSetup(definition)
    return ""
  } catch (error) {
    return (error as Error).message
  }
}

const server = (definition: SetupDefinition) => definition.steps.server as { blocks: unknown[] }

describe("defineSetup", () => {
  it("**builds the document from the CLI's identity**", () => {
    expect(defineSetup(flow()).document).toMatchObject({ format: "wirecat.setup", tool: "demo", toolVersion: "1.2.3" })
  })

  it.each([
    [
      "a setting the configuration does not declare",
      (d: SetupDefinition) => {
        server(d).blocks.push({ type: "input", id: "user", setting: "user", input: "text", label: "server.host" })
      },
      "setting user is not in the CLI's configuration",
    ],
    [
      "the permission table",
      (d: SetupDefinition) => {
        server(d).blocks.push({
          type: "input",
          id: "perm",
          setting: "permissions",
          input: "text",
          label: "server.host",
        })
      },
      "permissions is the owner's to set",
    ],
    [
      "a step nothing leads to",
      (d: SetupDefinition) => {
        d.steps.lost = { kind: "done", title: "done.title" }
      },
      "steps.lost: cannot be reached from server",
    ],
    [
      "a target that is not there",
      (d: SetupDefinition) => {
        ;(d.steps.server as { next: string }).next = "nowhere"
      },
      "names no step: nowhere",
    ],
    [
      "a text missing in English",
      (d: SetupDefinition) => {
        ;(d.steps.done as { title: string }).title = "done.missing"
      },
      "texts.en: has no done.missing",
    ],
    [
      "a tool action, reserved for later",
      (d: SetupDefinition) => {
        ;(d.steps.check as { action: string }).action = "oauth"
      },
      "oauth is not built in",
    ],
    [
      "a display class outside the reserved names",
      (d: SetupDefinition) => {
        server(d).blocks.push({ type: "text", text: "server.title", class: ["shadow-xl"] })
      },
      "class shadow-xl is not reserved",
    ],
    [
      "a role another block type has",
      (d: SetupDefinition) => {
        server(d).blocks.push({ type: "note", text: "server.title", role: "card" })
      },
      "role card is not one of note's",
    ],
    [
      "an input bound to nothing",
      (d: SetupDefinition) => {
        server(d).blocks.push({ type: "input", id: "free", input: "text", label: "server.host" })
      },
      "an input binds exactly one of setting or secret",
    ],
    [
      "a last edge with a condition",
      (d: SetupDefinition) => {
        ;(d.steps.check as { next: unknown }).next = [{ when: { result: "check", is: "ok" }, to: "done" }]
      },
      "the last edge has a condition",
    ],
    [
      "a condition on no input",
      (d: SetupDefinition) => {
        ;(d.steps.server as { next: unknown }).next = [
          { when: { field: "nope", set: true }, to: "check" },
          { to: "check" },
        ]
      },
      "field nope is no input's id",
    ],
    [
      "groups nested too deep",
      (d: SetupDefinition) => {
        let block: Record<string, unknown> = { type: "text", text: "server.title" }
        for (let level = 0; level < 9; level++) block = { type: "group", blocks: [block] }
        server(d).blocks.push(block)
      },
      "groups nest deeper than 8",
    ],
    [
      "more steps than a renderer takes",
      (d: SetupDefinition) => {
        for (let index = 0; index < 60; index++) d.steps[`extra-${index}`] = { kind: "done", title: "done.title" }
      },
      "steps: Invalid entries",
    ],
  ])("**refuses %s**", (_, change, said) => {
    expect(problemsOf(change)).toContain(said)
  })
})

describe("setupFileProblems", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  const packageWith = (files: Record<string, Buffer | string>) => {
    const root = mkdtempSync(join(tmpdir(), "setup-files-"))
    mkdirSync(join(root, "setup"))
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(root, name), bytes)
    return root
  }
  const withAsset = (file: string) => defineSetup({ ...flow(), assets: { shot: { file } } })

  it("**takes a PNG inside the package**, and refuses a missing file, an SVG by its bytes and one over 2 MB", () => {
    const root = packageWith({
      "setup/shot.png": PNG,
      "setup/fake.png": "<svg xmlns='http://www.w3.org/2000/svg'/>",
      "setup/big.png": Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]),
    })
    expect(setupFileProblems(withAsset("setup/shot.png"), root)).toEqual([])
    expect(setupFileProblems(withAsset("setup/none.png"), root)[0]).toContain("no such file")
    expect(setupFileProblems(withAsset("setup/fake.png"), root)[0]).toContain("is not a PNG, JPEG or WebP")
    expect(setupFileProblems(withAsset("setup/big.png"), root)[0]).toContain("over 2097152")
  })

  it("**refuses a link that leads out of the package**", () => {
    const root = packageWith({})
    const outside = join(mkdtempSync(join(tmpdir(), "setup-outside-")), "secret.png")
    writeFileSync(outside, PNG)
    symlinkSync(outside, join(root, "setup/linked.png"))
    expect(setupFileProblems(withAsset("setup/linked.png"), root)[0]).toContain("leads outside the package")
  })
})
