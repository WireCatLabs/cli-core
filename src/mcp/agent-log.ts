import { logRecordOf } from "@wirecat/cli-base"
import type { LogRecord } from "@wirecat/cli-base/standards"
import { LOG_ATTRIBUTES } from "../cli/runs/log-attributes.js"
import type { AgentAction } from "../store/index.js"
import type { MessageStore } from "../store/store.js"

type Action = Parameters<MessageStore["agentActions"]["record"]>[0]

/** One store for the audit rows, opened on the first call and kept until the server stops, not one per call. */
export const agentLog = (open: () => Promise<MessageStore>) => {
  let held: Promise<MessageStore> | undefined
  return {
    record: async (action: Action): Promise<void> => {
      held ??= open().catch((error: unknown) => {
        held = undefined
        throw error
      })
      await (await held).agentActions.record(action)
    },
    close: async (): Promise<void> => {
      const store = await held?.catch(() => undefined)
      held = undefined
      await store?.close()
    },
  }
}

const SEVERITY = { ok: "info", refused: "warn", failed: "error" } as const

/**
 * One audit row as a log record, for whoever exports the agent log. The table keeps no run id, so `run_id`
 * names the row instead (`<started>-agent-action-<id>`): it groups nothing and `runs show` does not open it.
 */
export const agentActionRecord = (action: AgentAction, resource: LogRecord["resource"]): LogRecord => {
  const started = action.startedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
  return logRecordOf({
    severity: SEVERITY[action.status],
    event: {
      event: "agent.action",
      tool: action.tool,
      tier: action.tier,
      outcome: action.status,
      actorType: action.actor.type,
      actorId: action.actor.id,
      ...(action.actor.name === null ? {} : { agent: action.actor.name }),
      ...(action.target === null ? {} : { targetType: action.target.type, targetId: action.target.id }),
      ...(action.error === null ? {} : { errorCode: action.error }),
      ...(action.finishedAt === null
        ? {}
        : { durationMs: Date.parse(action.finishedAt) - Date.parse(action.startedAt) }),
    },
    time: action.startedAt,
    runId: `${started}-agent-action-${action.id}`,
    command: `mcp ${action.tool.replaceAll("_", " ")}`,
    resource,
    allow: LOG_ATTRIBUTES,
  })
}
