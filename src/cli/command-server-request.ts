import { AsyncLocalStorage } from "node:async_hooks"

/** What a spawned process would own alone: its output, its stdin and its exit code. */
export interface CommandServerRequest {
  stdout: Buffer[]
  stderr: Buffer[]
  stdin: NodeJS.ReadableStream
  exitCode?: number
  /** Resolves once no other request runs, and keeps new ones waiting until this one ends. */
  alone: () => Promise<void>
}

const requests = new AsyncLocalStorage<CommandServerRequest>()

export const inCommandServerRequest = <T>(request: CommandServerRequest, work: () => T): T =>
  requests.run(request, work)

export const commandServerRequest = (): CommandServerRequest | undefined => requests.getStore()

/**
 * The exit code a command set without returning it. In a request, a direct `process.exitCode` write is taken and
 * cleared, since the process's one value is shared by every request in flight; `setExitCode` keeps it per request.
 */
export const exitCodeSet = (): number | undefined => {
  const request = requests.getStore()
  if (request?.exitCode !== undefined) return request.exitCode
  const direct = process.exitCode === undefined ? undefined : Number(process.exitCode)
  if (request) process.exitCode = undefined
  return direct
}
