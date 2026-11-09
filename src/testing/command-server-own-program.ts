import { CliError, errorObjectOf, exitCodeOfError, renderError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { startCli } from "../cli/entry.js"
import { app } from "./shared-program.js"

// A CLI with its own commander program, as memo starts one, for the command server's tests to spawn.
await startCli({
  app: { ...app, command: "own" },
  run: async (entry) => {
    const program = new Command("own").exitOverride()
    program.hook("preAction", (_root, command) => entry.atStart(command))
    annotate(program.command("serve"), { lifetime: "persistent" }).action(() => undefined)
    program.command("partial").action(() => {
      process.stdout.write("half\n")
      entry.setExitCode(6)
    })
    program.command("direct").action(() => {
      process.exitCode = 7
    })
    program.command("slow <name> <ms> <code>").action(async (name: string, ms: string, code: string) => {
      process.stdout.write(`${name} begins\n`)
      await new Promise((resolve) => setTimeout(resolve, Number(ms)))
      process.stderr.write(`${name} note\n`)
      await new Promise((resolve) => setImmediate(resolve))
      process.stdout.write(`${name} ends\n`)
      entry.setExitCode(Number(code))
    })
    program.command("ok").action(() => {
      // biome-ignore lint/suspicious/noConsole: `complete` prints through the console, which the server must catch too
      console.log("fine")
    })
    program.command("broken").action(() => {
      throw new CliError("conflict", "it broke")
    })
    await program.parseAsync(entry.args, { from: "user" })
    return undefined
  },
  fail: (error) => {
    const object = errorObjectOf(error)
    process.stderr.write(`${renderError(object, { cli: "own", interactive: false })}\n`)
    return exitCodeOfError(object)
  },
})
