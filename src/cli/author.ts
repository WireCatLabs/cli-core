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
