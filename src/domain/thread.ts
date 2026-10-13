import { CliError } from "@wirecat/cli-base"

export const threadIdOf = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const id = value.trim()
  if (id === "") throw new CliError("validation_error", "--topic needs the id of a forum topic")
  return id
}
