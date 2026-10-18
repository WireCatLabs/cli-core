import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import { environmentOf } from "./context.js"

/**
 * Who decides: the agent whose terminal runs the tool, by the variables cli-base's skill hint reads, else the
 * owner. `AI_AGENT` carries a version (`claude-code_2-1-296_agent`); one bot per release would split the agent's
 * history, so only the name before it is kept. memo's `--as-owner` follows the same rule.
 */
export const authorOf = (env: NodeJS.ProcessEnv, asOwner?: boolean): string => {
  if (asOwner) return "owner"
  const agent = env.AI_AGENT?.trim().split("_")[0]
  if (agent) return agent
  return env.CLAUDECODE ? "claude-code" : "owner"
}

/**
 * Who holds a task claim — one agent session, not the agent's name, so two Claude Code sessions do not share one
 * claim (owner, NEED-1119). `--holder`, then `WIRECAT_HOLDER`, then Claude Code's own session id, which it sets in
 * every process it starts; other agents set no session variable known here and fall back to their name.
 */
export const holderOf = (env: NodeJS.ProcessEnv, flag?: string): string => {
  const given = flag?.trim() || env.WIRECAT_HOLDER?.trim()
  if (given) return given.slice(0, 200)
  const session = env.CLAUDE_CODE_SESSION_ID?.trim()
  return session ? `claude-code:${session}` : authorOf(env)
}

/**
 * Who acts in this run. An MCP server's run is the agent's whatever the server's environment says, and an agent never
 * acts as the owner: the owner's decision over an agent's is what `--as-owner` records.
 */
export const actorOf = (command: Command, asOwner?: boolean): string => {
  const { env = process.env, agent } = environmentOf(command)
  if (!agent) return authorOf(env, asOwner)
  if (asOwner) throw new CliError("permission_error", "an agent cannot act as the owner; the owner runs this command")
  const named = authorOf(env)
  return named === "owner" ? "agent" : named
}
