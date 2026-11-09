import { errorObjectOf, exitCodeOfError, renderError } from "@wirecat/cli-base"
import { startCli } from "../cli/entry.js"
import { run } from "../cli/program.js"
import { app, sharedProgram } from "./shared-program.js"

// A CLI as tg starts one, for the command server's tests to spawn.
await startCli({
  app,
  run: ({ args }) => run(args, sharedProgram),
  fail: (error) => {
    const object = errorObjectOf(error)
    process.stderr.write(`${renderError(object, { cli: app.command, interactive: false })}\n`)
    return exitCodeOfError(object)
  },
})
