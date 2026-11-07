import { writeFile } from "node:fs/promises"
import { CliError } from "@wirecat/cli-base"

/** Writes a file that did not exist, private to the owner; one that exists is refused and left as it was. */
export const writeNewFile = async (path: string, content: string): Promise<void> => {
  try {
    await writeFile(path, content, { flag: "wx", mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new CliError("validation_error", "output file already exists; choose another path", { param: "--output" })
    throw error
  }
}
