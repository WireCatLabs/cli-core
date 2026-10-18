import { CliError } from "@wirecat/cli-base"

export const boundMeetingProjectCandidatesItem = (item: {
  items: unknown[]
  limits: { bytes: number }
  coverage: { has_more: boolean; output_limited: boolean }
}) => {
  while (Buffer.byteLength(JSON.stringify(item), "utf8") > item.limits.bytes) {
    if (!item.items.length)
      throw new CliError("validation_error", "project candidate bytes cannot fit required coverage")
    item.items.pop()
    item.coverage.has_more = item.coverage.output_limited = true
  }
}
