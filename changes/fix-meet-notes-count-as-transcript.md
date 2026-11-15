### Added

- **`TRANSCRIPT_WORDS`, in `@wirecat/cli-core/meetings`.** The words in the name of the Google Doc that Meet or Gemini
  saves ("Transcript", "Notes by Gemini" and their Russian and Spanish forms), moved from drive-cli so drive and the
  meetings list find transcripts by one list.

### Fixed

- **A Google Meet meeting with only Gemini notes counts as having a transcript.** `has_transcript` in the meetings
  list and the `has_transcript:` query field now also count a Drive document Meet named as a meeting's transcript or
  notes (an `attached` link with role `transcript` or `notes`), and an imported Drive document attached to the
  calendar event whose title holds one of `TRANSCRIPT_WORDS`. Before, only a stored meeting transcript counted, so
  Desktop's "Only with a transcript" hid every Meet meeting that had only Gemini notes. A calendar attachment has no
  role, so an agenda counts only if its title holds one of the words, and a document Drive has not imported yet does
  not count.
