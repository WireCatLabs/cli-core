import type { Command } from "commander"

/** `pagingOf` for a test of the commands outside cli-core's run, which has no profile: the flags, else 100 a page. */
export const flagPaging = (command: Command): { limit: number; page: number } => {
  const { limit, page } = command.opts<{ limit?: number; page?: number }>()
  return { limit: limit ?? 100, page: page ?? 1 }
}
