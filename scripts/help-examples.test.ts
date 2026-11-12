/**
 * Every shared command that runs renders an Example, and Returns only from a declared output; which still show a
 * generated example.
 *
 *   pnpm help:examples
 *
 * The list is a report, never a failure: it shows where a written example would help most.
 */
import { expect, it } from "vitest"
import { commandHelp, exampleReport } from "../src/cli/help/command-help.ts"
import { createProgram } from "../src/cli/program.ts"
import { sharedProgram } from "../src/testing/shared-program.ts"

it("every shared command that runs renders an Example, and Returns only from a declared output", () => {
  const program = createProgram(sharedProgram)
  const report = exampleReport(program)
  for (const path of [...report.written, ...report.generated]) {
    const command = path.split(" ").reduce((at, word) => at.commands.find((one) => one.name() === word) ?? at, program)
    const { returns, examples } = commandHelp(command)
    if (returns) expect(returns, path).not.toBe(command.description())
    expect(examples.length, path).toBeGreaterThan(0)
  }
  if (process.env.HELP_EXAMPLES_REPORT) console.log(report.text)
})
