import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { captureStreams } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { sharedProgram } from "../testing/shared-program.js"
import { checkGuide, checkStep, guideCommand, parseScenario, shellProblems } from "./guide.js"
import { createProgram, run } from "./program.js"

const call = async (argv: string[]) => {
  const streams = captureStreams()
  const code = await run(argv, sharedProgram, { streams, tty: false, env: {} })
  return { code, stdout: streams.stdout.join("\n"), stderr: streams.stderr.join("\n") }
}

describe("guide", () => {
  it("examples a scenario the tool has, never a placeholder", () => {
    const at = (directory: string) => metaOf(guideCommand({ command: "chat" }, { directory })).examples
    expect(at(fileURLToPath(new URL("fixtures/scenarios", import.meta.url)))).toEqual([
      "chat guide",
      "chat guide catch-up --json",
    ])
    expect(at(join(tmpdir(), "no-such-scenarios"))).toEqual(["chat guide"])
  })

  it("lists the scenarios and the ones another tool holds, with no profile", async () => {
    const { code, stdout } = await call(["guide"])

    expect(code).toBe(0)
    expect(stdout).toMatchInlineSnapshot(`
      "Scenarios — chat guide <name> for the steps:
        catch-up  Catch up after a day away

      Works with:
        memo guide person-brief  One person across every tool"
    `)
  })

  it("prints the goal, each step with why, and what to look at", async () => {
    const { stdout } = await call(["guide", "catch-up"])

    expect(stdout).toMatchInlineSnapshot(`
      "Catch up after a day away

      Goal: Know who waits on you and what you promised, without reading every chat.

      Steps — account commands start with your profile: chat <profile> …
        1. chat review 'date>1d' --unanswered 4h
           questions to you that nobody answered, across every chat
        2. chat messages list "Book club" --limit 20
           the chat behind a question, read in full
        3. chat tasks list
           what the review turned into tasks

      Look at:
        - who asked first and how long ago
        - tasks marked as yours"
    `)
  })

  it("gives the same content as data with --json", async () => {
    const list = JSON.parse((await call(["guide", "--json"])).stdout)
    expect(list.items.map((one: { command: string }) => one.command)).toEqual([
      "chat guide catch-up",
      "memo guide person-brief",
    ])

    const { item } = JSON.parse((await call(["guide", "catch-up", "--json"])).stdout)
    expect(item).toMatchObject({ name: "catch-up", goal: expect.any(String), look: expect.any(Array) })
    expect(item.steps[0]).toEqual({
      run: "chat review 'date>1d' --unanswered 4h",
      why: "questions to you that nobody answered, across every chat",
    })
  })

  it("is named on the first screen once mounted", async () => {
    expect((await call(["--help"])).stdout).toContain("chat guide")
  })

  it("points at the tool that holds a scenario it only lists", async () => {
    const { code, stderr } = await call(["guide", "person-brief"])

    expect(code).not.toBe(0)
    expect(stderr).toContain("memo guide person-brief")
  })
})

describe("checkGuide", () => {
  it("passes the fixture's steps on the shared commands", async () => {
    expect(await checkGuide(() => createProgram(sharedProgram))).toEqual([])
  })

  it("asks for the scenario directory in the package's files", async () => {
    const root = mkdtempSync(join(tmpdir(), "guide-package-"))
    writeFileSync(join(root, "package.json"), JSON.stringify({ files: ["dist"] }))
    const program = () =>
      new Command("t").addCommand(guideCommand({ command: "t" }, { directory: join(root, "scenarios") }))

    expect(await checkGuide(program, { packageRoot: root })).toEqual([
      `${join(root, "scenarios")}: no such directory`,
      "package.json files leaves out scenarios",
    ])
    writeFileSync(join(root, "package.json"), JSON.stringify({ files: ["dist", "scenarios/"] }))
    expect(await checkGuide(program, { packageRoot: root })).toEqual([`${join(root, "scenarios")}: no such directory`])
  })

  it.each([
    ["tg review", 'starts with "tg", not chat'],
    ["chat personal nothing", 'no command "personal"'],
    ["chat mesages list Team", 'no command "mesages"'],
    ["chat messages", "needs one of:"],
    ["chat messages list Team --nope", "no option --nope"],
    ["chat messages list Team --limit", "--limit needs a value"],
    ["chat messages list Team --limit 0", "--limit:"],
    ["chat messages list", "needs <chat>"],
    ["chat messages link Team 1 extra", "takes 2 argument(s)"],
  ])("finds what is wrong with %s", (line, problem) => {
    expect(checkStep(createProgram(sharedProgram), line).join("; ")).toContain(problem)
  })

  it.each([
    "chat messages list --help",
    "chat messages list -h",
    "chat messages --help",
    "chat personal messages list Team",
  ])("accepts %s", (line) => {
    expect(checkStep(createProgram(sharedProgram), line)).toEqual([])
  })

  it("accepts the root's options and quoted words", () => {
    expect(checkStep(createProgram(sharedProgram), 'chat messages list "Book club" --json --limit=5')).toEqual([])
  })

  it.each([
    ["chat review date>1d", ">"],
    ["chat search all a<b", "<"],
    ["chat inbox --json | jq .", "|"],
    ["chat inbox & chat tasks list", "&"],
    ["chat inbox; chat tasks list", ";"],
    ["chat search all `whoami`", "`"],
    ["chat search all $(whoami)", "$("],
    ['chat search all "$(whoami)"', "$("],
    ["chat search all invoice*", "*"],
    ["chat search all why?", "?"],
    ["chat search all [ab]", "["],
  ])("finds the shell acting on %s", (line, char) => {
    expect(shellProblems(line)).toEqual([expect.stringContaining(`a shell acts on ${char}:`)])
  })

  it.each([
    "chat review 'date>1d' --unanswered 4h",
    'chat review "date>1d"',
    "chat review date\\>1d",
    'chat search all "why?" \'a|b\' "[x]" subject:"person:42"',
    'chat search all "price \\$(x)"',
    "chat schedule list -- messages sync --all",
  ])("passes quoted and escaped words: %s", (line) => {
    expect(shellProblems(line)).toEqual([])
  })

  it("finds a quote never closed", () => {
    expect(shellProblems('chat search all "invoice')).toEqual(["a quote is never closed"])
  })

  it("reports the shell's problems for each scenario step", async () => {
    const root = mkdtempSync(join(tmpdir(), "guide-shell-"))
    writeFileSync(join(root, "x.md"), "---\ntitle: X\ngoal: Y\nsteps:\n  - run: t date>1d\n    why: z\nlook: w\n---\n")
    const program = () => new Command("t").addCommand(guideCommand({ command: "t" }, { directory: root }))

    expect(await checkGuide(program)).toContain(
      "x.md step 1 (t date>1d): a shell acts on >: it redirects output to a file; put the word in single quotes",
    )
  })
})

it("says what a scenario file is missing", async () => {
  expect((await parseScenario("Bad Name.md", "")).problems).toEqual([
    "Bad Name.md: the file name is the scenario's name: lower case words and dashes",
  ])
  expect((await parseScenario("x.md", "---\ntitle: X\nsteps:\n  - run: chat inbox\nextra: 1\n---\n")).problems).toEqual(
    [
      "x.md: unknown field extra; the fields are title, goal, steps, look",
      "x.md: goal is a line of text",
      "x.md: step 1 needs run and why",
      "x.md: look is what to look at in the output: a line or a list of lines",
    ],
  )
})
