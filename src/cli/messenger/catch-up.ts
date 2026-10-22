import type { Command } from "commander"
import { environmentOf } from "../context.js"

/** Whose `--new` points a run moves: an agent's are its own, so the owner's `inbox --new` still shows everything. */
export const pointsOf = <N extends "inbox" | "review">(command: Command, name: N): N | `mcp-${N}` =>
  environmentOf(command).agent ? `mcp-${name}` : name
