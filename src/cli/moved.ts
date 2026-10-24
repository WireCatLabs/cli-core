/**
 * Commands a source tool no longer has, each with the memo command that does the job
 * (docs/dev/TOOL-BOUNDARIES.md). The CLI and the MCP server answer with the pointer instead of
 * "unknown command"; a path the program still mounts never reaches it.
 */
export const MOVED_TO_MEMO: Readonly<Record<string, { what: string; memo: string }>> = {
  "search mail": { what: "mail is searched by the separate memo CLI", memo: "memo search mail …" },
}

/** Retired spellings are guidance only; none is mounted as a command alias. */
export const RENAMED_COMMANDS: Readonly<Record<string, string>> = {
  "contacts alias rm": "contacts aliases remove",
  "contacts alias": "contacts aliases",
  "contacts profile": "contacts info",
  "contacts timeline": "contacts events",
  "chats link revoke": "chats links remove",
  "chats link": "chats links",
  "chats members audit": "chats members check",
  "chats requests accept": "chats requests confirm",
  "chats requests decline": "chats requests reject",
  "metadata get": "metadata show",
  "metadata refresh": "metadata sync",
  "tasks plan": "tasks update",
  "tags auto": "tags rebuild",
  "attachments text set": "attachments update",
  "conversations build": "conversations links rebuild",
  "conversations embed status": "conversations embeddings status",
  "conversations embed clear": "conversations embeddings clear",
  "conversations batches next": "conversations batches show",
  "conversations consents revoke": "conversations consents remove",
  "doctor report create": "doctor reports create",
  "doctor report": "doctor reports show",
  "mcp setup": "mcp add",
  "mcp doctor": "mcp check",
  "commands schema": "commands info",
  "bot store fetch": "bot messages sync",
  "store gaps plan": "store gaps show",
  "store reindex": "store rebuild",
  "stats messages counters refresh": "stats messages counters sync",
  "models text key": "models keys",
  "models audio list": "models list kind:audio",
  "models text list": "models list kind:text",
  "models audio download": "models download",
  "models text download": "models download",
}

export const movedPointer = (path: string): string | undefined => {
  const renamed = RENAMED_COMMANDS[path]
  if (renamed) return `use \`${renamed}\``
  const moved = MOVED_TO_MEMO[path]
  return moved && `${moved.what}: install @wirecat/cli-memo, then \`${moved.memo}\``
}

/** The longest moved path the words start with, unless the program still has it. */
export const movedPath = (words: readonly string[], has: (path: string) => boolean): string | undefined =>
  [...Object.keys(MOVED_TO_MEMO), ...Object.keys(RENAMED_COMMANDS)]
    .filter((path) => path.split(" ").every((word, at) => words[at] === word))
    .sort((a, b) => b.length - a.length)
    .find((path) => !has(path))
