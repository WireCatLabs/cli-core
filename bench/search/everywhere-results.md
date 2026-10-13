# Search everywhere — latency of a bare word

A bare word looks in message text, voice transcripts, file names and file text (#1025). This measures what that
costs, with `everywhere.ts`, on 2026-10-13.

## Setup

- AMD Ryzen AI 9 HX 470, Linux 7.0, Node v24.19.0 (`node:sqlite`). Store in the OS temp folder.
- Synthetic store: 100,000 messages in one chat, 50,000 of them with a file. Every 20th file name and file text
  holds `heron`; one spreadsheet of 75k characters repeats it on every row.
- 30 rounds per query, limit 20, Lucene language. `p50` / `p95` in ms, warm.
- Run: `node everywhere.ts <repo with dist/> 100000 50000` on each build.

## Results

| Query | before #1025 (`db178517`) | #1025, names read in JS (`b7429317`) | #1025, name index (`7272ae8f`) |
|---|---|---|---|
| `heron` | 120 / 123 | 388 / 421 | 137 / 164 |
| `ledger` | 120 / 128 | 402 / 428 | 153 / 166 |
| `heron AND river` | 111 / 120 | 401 / 418 | 154 / 181 |
| `invoice OR census` | 168 / 171 | 480 / 553 | 210 / 233 |
| `квартира` | 119 / 145 | 390 / 426 | 141 / 145 |
| `text:heron` | 118 / 136 | 121 / 130 | 127 / 141 |
| `zzznothing` (no match) | 73 / 75 | 339 / 389 | 86 / 104 |

## What it shows

- Reading every file name into JavaScript on each search cost a fixed ~270 ms at this size, even with no match.
  On the owner's store (4,436 messages, 2,430 files) the same build went from ~7 to ~18 ms p50.
- The FTS5 index of file names (`attachment_name_words`, store version 5) removes that: a bare word now costs
  15–40 ms more than message text alone. Probably the lookups in file text and transcripts; not measured apart.
- `text:` does not touch the other places and stays where it was.
