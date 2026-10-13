import { projectFields as coreProjectFields } from "@wirecat/cli-base"

export { fieldsOf } from "@wirecat/cli-base"

/** cli-base keeps `operation_id` and `send_id`; this package's results still say `operationId` and `sendId`. */
const CORRELATION = ["operationId", "sendId"]

export const projectFields = (value: unknown, fields: readonly string[]): unknown =>
  coreProjectFields(value, [...fields, ...CORRELATION.filter((name) => !fields.includes(name))])
