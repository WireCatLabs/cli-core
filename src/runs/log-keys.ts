import type { Logger } from "@wirecat/cli-base"

const snake = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
const camel = (key: string) => key.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase())

const renamed = (record: object, name: (key: string) => string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [name(key), value]))

/**
 * A log record's attributes as written: snake_case at the top level only — `ids` and `counts` are keyed by
 * data, not by field names.
 */
export const logAttributes = (event: object): Record<string, unknown> => renamed(event, snake)

/**
 * Attributes as the code reads them, from a line written either way: files on disk still hold records from
 * before the keys were snake_case, and are kept for as long as `keepRunsForDays` says.
 */
export const fromLogAttributes = (attributes: object): Record<string, unknown> => renamed(attributes, camel)

/** A logger that writes every event's keys in snake_case. */
export const snakeLogger = (logger: Logger): Logger => ({
  debug: (event, message) => logger.debug(logAttributes(event), message),
  info: (event, message) => logger.info(logAttributes(event), message),
  warn: (event, message) => logger.warn(logAttributes(event), message),
  error: (event, message) => logger.error(logAttributes(event), message),
})
