/**
 * Commands a source tool no longer has, each with the memo command that does the job
 * (docs/dev/TOOL-BOUNDARIES.md). The CLI and the MCP server answer with the pointer instead of
 * "unknown command"; a path the program still mounts never reaches it.
 */
export const MOVED_TO_MEMO: Readonly<Record<string, { what: string; memo: string }>> = {
  "search mail": { what: "mail is searched by the separate memo CLI", memo: "memo search mail …" },
}

export const movedPointer = (path: string): string | undefined => {
  const moved = MOVED_TO_MEMO[path]
  return moved && `${moved.what}: install @wirecat/cli-memo, then \`${moved.memo}\``
}

/** The longest moved path the words start with, unless the program still has it. */
export const movedPath = (words: readonly string[], has: (path: string) => boolean): string | undefined =>
  Object.keys(MOVED_TO_MEMO)
    .filter((path) => path.split(" ").every((word, at) => words[at] === word))
    .sort((a, b) => b.length - a.length)
    .find((path) => !has(path))
