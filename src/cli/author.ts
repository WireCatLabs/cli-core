import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import { agentOf } from "../runs/run-context.js"
import { environmentOf } from "./context.js"

/**
 * Who decides: the agent whose terminal runs the tool, by the variables each agent sets (`agentOf`, the same
 * detection a run record uses), else the owner. memo's `--as-owner` follows the same rule.
 */
export const authorOf = (env: NodeJS.ProcessEnv, asOwner?: boolean): string =>
  asOwner ? "owner" : (agentOf(env)?.kind ?? "owner")

/**
 * Who holds a task claim — one agent session, not the agent's name, so two sessions of one agent do not share one
 * claim (owner, NEED-1119). `--holder`, then `WIRECAT_HOLDER`, then the agent's own session id where it sets one
 * (Claude Code, Codex, OpenCode, Hermes), else the agent's name.
 */
export const holderOf = (env: NodeJS.ProcessEnv, flag?: string): string => {
  const given = flag?.trim() || env.WIRECAT_HOLDER?.trim()
  if (given) return given.slice(0, 200)
  const agent = agentOf(env)
  return agent?.session_id ? `${agent.kind}:${agent.session_id}` : authorOf(env)
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
