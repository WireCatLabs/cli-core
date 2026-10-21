import { Command } from "commander"
import { expect, it } from "vitest"
import { addMeetingCommands, addMeetingProjectEvidenceCommand, type MeetingCommandDeps } from "./index.js"

const leaves = (command: Command, path: string[] = []): string[][] =>
  command.commands.length === 0 ? [path] : command.commands.flatMap((sub) => leaves(sub, [...path, sub.name()]))

it("prints help and exits 0 for --help and -h on every meetings command", async () => {
  const build = () => {
    const out: string[] = []
    const program = new Command("zm").exitOverride().configureOutput({
      writeOut: (text) => out.push(text),
      writeErr: (text) => out.push(text),
    })
    const forbidden = () => {
      throw new Error("help never reads the store")
    }
    addMeetingCommands(program, { store: {}, accountId: 1, write: forbidden } as unknown as MeetingCommandDeps)
    addMeetingProjectEvidenceCommand(program, { read: forbidden, signal: () => undefined, output: forbidden } as never)
    return { program, out }
  }
  const all = leaves(build().program)
  expect(all).toContainEqual(["meetings", "list"])
  expect(all).toContainEqual(["meetings", "projects", "evidence"])

  const failed: string[] = []
  for (const path of all)
    for (const flag of ["--help", "-h"]) {
      const { program, out } = build()
      const exit = await program.parseAsync([...path, flag], { from: "user" }).then(
        () => "no exit",
        (error: { exitCode?: number }) => error.exitCode,
      )
      if (exit !== 0 || !out.join("").includes(`Usage: zm ${path.join(" ")}`))
        failed.push(`${path.join(" ")} ${flag}: ${exit} ${out.join("").slice(0, 120)}`)
    }
  expect(failed).toEqual([])
})

it("shows the host's note on its file names under meetings import --help", async () => {
  const out: string[] = []
  const program = new Command("zm").exitOverride().configureOutput({ writeOut: (text) => out.push(text) })
  addMeetingCommands(program, {
    store: {},
    accountId: 1,
    write: () => undefined,
    importHelp: "Files: YYYY-MM-DD_HHMM_topic.vtt, read in Europe/Madrid.",
  } as unknown as MeetingCommandDeps)
  await program.parseAsync(["meetings", "import", "--help"], { from: "user" }).catch(() => undefined)
  expect(out.join("")).toContain("Files: YYYY-MM-DD_HHMM_topic.vtt, read in Europe/Madrid.")
})
