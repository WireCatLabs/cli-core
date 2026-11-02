import type { Command } from "commander"
import type { AppIdentity } from "../../ports/app.js"
import { environmentOf } from "../context.js"

/**
 * Whose `--new` points a run moves. A scheduled run (`<PREFIX>_SCHEDULED`) keeps one per schedule, an agent over MCP
 * one of its own, and the owner the plain one: no reader moves another's point past what it never showed.
 */
export const pointsOf = (command: Command, name: string, app: Pick<AppIdentity, "envPrefix">): string => {
  const { agent, env } = environmentOf(command)
  const scheduled = (env ?? process.env)[`${app.envPrefix}_SCHEDULED`]?.trim()
  if (scheduled) return `schedule-${scheduled.replace(/[^a-z0-9-]/gi, "_")}-${name}`
  return agent ? `mcp-${name}` : name
}
