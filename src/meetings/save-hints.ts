/**
 * For the host's MCP server instructions, never an answer. The writes live in wcat, a separate server and CLI,
 * so it names them as optional: an agent without wcat connected must be able to ignore it.
 */
export const SAVE_INSTRUCTION =
  "If this shows something worth keeping — a decision, a promise, a preference — and wcat's server is connected, " +
  "propose it with facts_add or memories_add, citing the msg: locator or meeting: reference. Otherwise skip this."

export const SAVE_HELP = `Worth keeping — a decision, a promise, a preference? Record it with \`wcat facts add\` or
\`wcat memories add\`, citing the msg: locator or meeting: reference as --evidence.`
