import { captureStreams } from "@wirecat/cli-base"
import type { ProgramDefinition, RunOptions } from "./program.js"
import { run } from "./program.js"

export interface AgentTask {
  id: string
  request: string
  maxCalls: number
  check: (observations: readonly Observation[]) => boolean
}
export interface Observation {
  argv: readonly string[]
  exitCode: number
  stdout: readonly string[]
  stderr: readonly string[]
  outputBytes: number
}
export type AgentPolicy = (
  task: Pick<AgentTask, "id" | "request">,
  call: (argv: string[]) => Promise<Observation>,
) => Promise<void>
export interface EvaluationResult {
  task: string
  correct: boolean
  calls: number
  outputBytes: number
  failure?: "call_limit" | "agent_failed" | "incorrect"
}

/** The harness records metrics, never message bodies, credentials, request operands or policy reasoning. */
export const evaluateAgent = async (
  tasks: readonly AgentTask[],
  agent: AgentPolicy,
  definition: ProgramDefinition,
  environment: RunOptions,
): Promise<EvaluationResult[]> => {
  const results: EvaluationResult[] = []
  for (const task of tasks) {
    const observations: Observation[] = []
    let failure: EvaluationResult["failure"]
    try {
      await agent({ id: task.id, request: task.request }, async (argv) => {
        if (observations.length >= task.maxCalls) {
          failure = "call_limit"
          throw new Error("agent task call limit")
        }
        const streams = captureStreams()
        const exitCode = await run(argv, definition, { ...environment, streams })
        const observation: Observation = {
          argv: [...argv],
          exitCode,
          stdout: [...streams.stdout],
          stderr: [...streams.stderr],
          outputBytes: [...streams.stdout, ...streams.stderr].reduce(
            (total, line) => total + Buffer.byteLength(line) + 1,
            0,
          ),
        }
        observations.push(observation)
        return observation
      })
    } catch {
      failure ??= "agent_failed"
    }
    const correct = failure === undefined && task.check(observations)
    results.push({
      task: task.id,
      correct,
      calls: observations.length,
      outputBytes: observations.reduce((sum, observation) => sum + observation.outputBytes, 0),
      ...(!correct ? { failure: failure ?? "incorrect" } : {}),
    })
  }
  return results
}
