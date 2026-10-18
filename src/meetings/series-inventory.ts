import { CliError } from "@wirecat/cli-base"
import { type MeetingProviderScope, snapshotMeetingScope } from "./provider.js"
import type {
  MeetingSeriesInventoryPort,
  MeetingSeriesInventoryRequest,
  MeetingSeriesInventoryResult,
} from "./series-inventory-types.js"
import {
  inventoryCursor,
  inventoryHash,
  inventoryPage,
  inventoryRequest,
  inventorySize,
} from "./series-inventory-validation.js"

const cancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new CliError("cancelled", "meeting inventory reading was cancelled")
}
export const createMeetingSeriesInventoryReader = (scope: MeetingProviderScope, port: MeetingSeriesInventoryPort) => {
  const fixed = snapshotMeetingScope(scope)
  if (typeof port?.read !== "function")
    throw new CliError("configuration_error", "bounded meeting inventory reader is required")
  const read = port.read.bind(port)
  return {
    scope: fixed,
    async page(input: MeetingSeriesInventoryRequest): Promise<MeetingSeriesInventoryResult> {
      const request = inventoryRequest(fixed, input)
      const { after, until, limits, signal, cursor } = request
      cancelled(signal)
      const raw = await read(
        Object.freeze({
          scope: fixed,
          after,
          until,
          limit: limits.limit,
          maxReadBytes: limits.maxReadBytes,
          ...(cursor === undefined ? {} : { cursor }),
          ...(signal ? { signal } : {}),
        }),
      )
      cancelled(signal)
      const page = inventoryPage(fixed, request, raw)
      const packet = {
        schemaVersion: 1 as const,
        kind: "meeting_series_inventory" as const,
        scope: fixed,
        after,
        until,
        items: page.items,
        nextCursor: page.nextCursor === null ? null : inventoryCursor(request.selection, page.nextCursor),
        limits,
        coverage: {
          selection: page.selection,
          sourcePartial: page.partial,
          hasMore: page.nextCursor !== null,
          undated: page.items.filter((item) => item.scheduledStartAt === null).length,
          dateHintsOutsideWindow: page.items.filter(
            (item) =>
              item.scheduledStartAt !== null && (item.scheduledStartAt < after || item.scheduledStartAt >= until),
          ).length,
          calendarCompleteness: "unknown" as const,
          occurrenceProof: "not-read" as const,
          consistency: "live-provider-pages" as const,
        },
      }
      const result = { ...packet, fingerprint: inventoryHash(packet) }
      if (inventorySize(result) > limits.bytes)
        throw new CliError(
          "validation_error",
          "meeting inventory bytes cannot fit the provider page; increase bytes or lower limit",
        )
      cancelled(signal)
      return result
    },
  }
}
