/**
 * The only logging contract core knows about. The CLI adapts Pino to it; a Worker can pass
 * its own. Core never imports a logging library — see docs/dev/ARCHITECTURE.md.
 */
export interface Logger {
  debug(event: object, message?: string): void
  info(event: object, message?: string): void
  warn(event: object, message?: string): void
  error(event: object, message?: string): void
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
