import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import { readSecret } from "../../terminal/prompt.js"
import { environmentOf } from "../context.js"

export const ENCRYPT_OPTION = [
  "--encrypt",
  "compress and encrypt with a password, typed at a hidden prompt or piped on stdin; it is never kept — lose it and the file cannot be opened",
] as const

/**
 * The owner's password: typed at a hidden prompt, or piped on stdin by an agent the owner gave it
 * to. Never an argument — shell history and the process list keep those — and never written
 * anywhere. Typed for sealing, it is asked twice: a typo would lock the file for good.
 */
export const passwordOf = async (command: Command, { twice }: { twice: boolean }): Promise<string> => {
  const stdin = environmentOf(command).stdin
  const input = stdin ? { input: stdin } : {}
  const password = await readSecret("Password (not kept anywhere): ", input)
  if (password.length === 0) throw new CliError("validation_error", "no password given — typed, or piped on stdin")
  if (twice && (stdin ?? process.stdin).isTTY === true) {
    if ((await readSecret("Again: ", input)) !== password) {
      throw new CliError("validation_error", "the two passwords differ — nothing was written")
    }
  }
  return password
}
