import { CliError } from "@wirecat/cli-base"
import { meetingPreparationAnswer } from "../src/cli/meeting-preparation-answer.js"
import { createContextEvidenceReader } from "../src/services/context-evidence.js"
import { createMeetingPreparationService } from "../src/services/meeting-preparation.js"
import { contextEvidenceFixture } from "../src/testing/context-evidence.js"

export const smokeContextEvidence = async (check: (name: string, passes: boolean) => void) => {
  for (const provider of ["example-calendar", "sample-calendar"]) {
    const f = await contextEvidenceFixture(provider)
    try {
      if (!f.store.contextEvidence) throw new Error("Missing native context capability")
      f.db.prepare("UPDATE documents SET front_matter=? WHERE id=?").run(
        JSON.stringify({
          source: "google-drive",
          sourceUrl: "https://example.test/original",
          modifiedAt: "1970-01-01T00:00:00.200Z",
        }),
        Number(f.doc.id),
      )
      const reader = createContextEvidenceReader(f.store.contextEvidence, Object.values(f.sources))
      for (const source of Object.values(f.sources)) {
        const page = await reader.read({ ...f.request, source, after: 0, before: 10000 })
        check(
          `${provider} bounded ${source.kind} has cited local evidence`,
          page.items.length === 1 &&
            page.items[0]?.ref.startsWith(source.kind === "document" ? "document:" : "msg:") === true,
        )
        if (source.kind === "document")
          check(
            `${provider} preserves imported subsecond time and URL`,
            page.items[0]?.at === 200 && page.items[0]?.url === "https://example.test/original",
          )
      }
      const first = await reader.read(f.request)
      if (!first.next) throw new Error("Missing context cursor")
      check(
        `${provider} continues a bounded page`,
        (await reader.read({ ...f.request, cursor: first.next })).items[0]?.text === "Harbour launch 2",
      )
      const refused = await reader.read({ ...f.request, maxReadBytes: 1 }).then(
        () => false,
        (error) => error instanceof CliError && error.details?.reason === "context.read-budget",
      )
      check(`${provider} refuses oversized context before hydration`, refused)
      const selections = Object.entries(f.sources).map(([id, source]) => ({ id, source }))
      const preparation = createMeetingPreparationService(f.key, f.accountId, {
        meetings: f.store.meetings,
        upcoming: f.upcoming,
        communications: { selections, reader: f.store.contextEvidence },
      })
      const packet = await preparation.prepare("example-series", {
        after: 10000,
        until: 20000,
        historyAfter: 0,
        communications: { sources: selections.map(({ id }) => ({ id })), query: "launch" },
      })
      const answer = meetingPreparationAnswer(packet)
      check(
        `${provider} assembles strict cross-source preparation`,
        answer.item.communications?.items.length === 5 &&
          answer.item.communications.sources.length === 3 &&
          answer.meta?.complete === true,
      )
    } finally {
      await f.close()
    }
  }
}
