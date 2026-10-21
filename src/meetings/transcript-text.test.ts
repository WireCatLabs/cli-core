import { describe, expect, it } from "vitest"
import { importFiles } from "./import.js"
import { memoryMeetingStore, sampleMeeting } from "./testing/index.js"
import { parseTranscriptText, TranscriptTextError } from "./transcript-text.js"

const transcript = `Встреча: Планёрка по релизу
Дата: Mar 4, 2026 10:30 AM
Zoom ID: 00000000000
Говорят: Alice Example, Bob Sample
Реплик: 3

————————————————————————————————————————————————————————————

[00:03:12] Alice Example: Выкатываем в четверг, если тесты зелёные.

[00:03:40] Bob Sample: Тогда предупрежу поддержку.
И напишу в канал: заранее.

[01:02:03] Без имени говорящего
`

describe("parseTranscriptText", () => {
  it("reads the header and every line, a line ending where the next begins", () => {
    expect(parseTranscriptText(transcript)).toEqual({
      header: {
        title: "Планёрка по релизу",
        date: "Mar 4, 2026 10:30 AM",
        meetingId: "00000000000",
        speakers: ["Alice Example", "Bob Sample"],
      },
      lines: [
        { startMs: 192000, endMs: 220000, speaker: "Alice Example", text: "Выкатываем в четверг, если тесты зелёные." },
        {
          startMs: 220000,
          endMs: 3723000,
          speaker: "Bob Sample",
          text: "Тогда предупрежу поддержку.\nИ напишу в канал: заранее.",
        },
        { startMs: 3723000, endMs: 3723000, speaker: null, text: "Без имени говорящего" },
      ],
    })
  })

  it("keeps the first line an early file glued to the rule, and reads an empty header field as none", () => {
    const glued = "Встреча: Встреча\nДата: —\nZoom ID: \nГоворят: —\n\n——————————————\n[00:00:01] Alice Example: Начнём"
    expect(parseTranscriptText(glued)).toEqual({
      header: { title: "Встреча", date: null, meetingId: null, speakers: [] },
      lines: [{ startMs: 1000, endMs: 1000, speaker: "Alice Example", text: "Начнём" }],
    })
  })

  it("refuses a file with no header", () => {
    expect(() => parseTranscriptText("[00:00:01] Alice Example: Начнём")).toThrow(TranscriptTextError)
  })
})

describe("importFiles with a text transcript", () => {
  it("stores its lines and speakers", async () => {
    const store = memoryMeetingStore()
    const { meeting, participants } = sampleMeeting()
    expect(
      (await importFiles([{ meeting, participants, content: transcript, format: "text" }], store, 4000)).transcriptRows,
    ).toBe(3)
    const [stored] = await store.meetings()
    const details = await store.meeting(stored?.id ?? 0)
    expect(details?.transcripts[0]?.transcript.format).toBe("text")
    expect(details?.transcripts[0]?.rows.map((row) => [row.speakerName, row.startMs])).toEqual([
      ["Alice Example", 192000],
      ["Bob Sample", 220000],
      [null, 3723000],
    ])
  })
})
