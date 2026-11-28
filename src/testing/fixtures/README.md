# Test fixtures

## `quiet-middle.ogg`

20 seconds of Russian speech with a quiet stretch in the middle, for the voice detector test in
`src/speech/speech.test.ts`.

- **Source:** LibriVox, «Сказки» by M. E. Saltykov-Shchedrin, section 18 «Кисель», read by Lika
  ([archive.org item `skazki_2110_librivox`](https://archive.org/details/skazki_2110_librivox),
  file `tales_18_shedrin_64kb.mp3`). The recording says so itself at 5 s: «Эта запись LibriVox является
  общественным достоянием» — it is in the public domain.
- **Made with:**

  ```sh
  ffmpeg -ss 14.5 -i tales_18_shedrin_64kb.mp3 -t 20.3 \
    -af "volume=enable='between(t,10.6,16.7)':volume=-25dB" \
    -ac 1 -ar 48000 -c:a libopus -b:a 24k -map_metadata -1 quiet-middle.ogg
  ```

- **Why −25 dB:** the voice detector at its old threshold 0.5 drops the whole quiet sentence from −24 to
  −26 dB and keeps it at 0.3; −25 is the middle of that band (measured 2026-09-30). Quieter than −27 dB,
  0.3 loses part of it too.

## `tone.mp3`, `tone.flac`, `tone.vorbis.ogg`, `tone.aac`

`tone.ogg` in the formats the bundled decoders read, and raw AAC (ADTS), which only ffmpeg reads, for
`src/speech/decode.test.ts`:

```sh
ffmpeg -i tone.ogg -ac 1 -c:a libmp3lame -b:a 32k -map_metadata -1 tone.mp3
ffmpeg -i tone.ogg -ac 1 -ar 16000 -c:a flac -map_metadata -1 tone.flac
ffmpeg -i tone.ogg -ac 1 -c:a libvorbis -q:a 0 -map_metadata -1 tone.vorbis.ogg
ffmpeg -i tone.ogg -ac 1 -c:a aac -b:a 32k -f adts -map_metadata -1 tone.aac
```

## `dialogue.mp3`

A 14.3-second two-channel MP3 at 8 kHz, cut from `quiet-middle.ogg`, shaped like a recorded sales call: the left
channel speaks at 0–4 s and 11–14.3 s, the right at 5–10.7 s, so the turns interleave. For the channel test in
`src/speech/decode.test.ts` and the dialogue test in `src/speech/openai.test.ts`:

```sh
ffmpeg -i quiet-middle.ogg -filter_complex "[0:a]aresample=8000,asplit=3[a][b][c];\
[a]atrim=0:4,asetpts=N/SR/TB[A];[b]atrim=4.7:10.4,asetpts=N/SR/TB[B];[c]atrim=17:20.3,asetpts=N/SR/TB[C];\
anullsrc=r=8000:cl=mono,atrim=0:7[s7];anullsrc=r=8000:cl=mono,atrim=0:5[s5];anullsrc=r=8000:cl=mono,atrim=0:3.6[s36];\
[A][s7][C]concat=n=3:v=0:a=1[L];[s5][B][s36]concat=n=3:v=0:a=1[R];[L][R]join=inputs=2:channel_layout=stereo[out]" \
  -map "[out]" -c:a libmp3lame -b:a 32k -map_metadata -1 dialogue.mp3
```

## `silero_vad.onnx`

The voice detector model the speech code downloads (`VAD` in `src/speech/models.ts`, same sha256), so
the test runs without a download. Silero VAD, MIT license — [`silero_vad.LICENSE`](silero_vad.LICENSE),
from [snakers4/silero-vad](https://github.com/snakers4/silero-vad).

## `legacy.doc`

A 9.5 KB Word 97–2003 document with invented text (English and Russian), for the `.doc` reader test in
`src/attachments/documents.test.ts`. Binary `.doc` cannot be built in a test without a writer library.

- **Made with:** `soffice --headless --convert-to doc legacy.txt` (LibreOffice), from a text file holding
  "Synthetic legacy memo", a blank line and "The heron count rose to 42 in October. Цапли вернулись."

## `letter.docx`

A 5.6 KB Word document with invented text, for the paragraph editor tests in `src/office/docx.test.ts`: a heading, a
paragraph with one bold word, a plain paragraph, a two-cell table and a closing paragraph. LibreOffice writes its zip
entries with data descriptors, so the tests cover copying those byte for byte.

- **Made with** LibreOffice 26.2 headless from this HTML, once:

  ```sh
  echo '<html><body><h1>Synthetic letter</h1><p>Dear <b>heron</b>, the pond is ready.</p><p>Plain second paragraph.</p><table border="1"><tr><td>Cell one</td><td>Cell two</td></tr></table><p>Closing words.</p></body></html>' > letter.html
  soffice --headless --convert-to docx:"MS Word 2007 XML" letter.html
  ```

## `budget.xlsx`

A 6.5 KB workbook with invented numbers, for the spreadsheet reader test in `src/attachments/extract.test.ts`:
one sheet "Synthetic Budget", a header row, a date, a percentage format and a formula with a cached result.

- **Made with** ExcelJS 4.4.0, once, so the tests need no workbook writer:

  ```js
  const sheet = workbook.addWorksheet("Synthetic Budget")
  sheet.addRow(["Item", "Amount", "Paid", "Share"])
  sheet.addRow(["Rent", 1200, new Date(Date.UTC(2026, 2, 1)), 0.25])
  sheet.addRow(["Heron food", 0.1 + 0.2, undefined, undefined])
  sheet.getCell("D2").numFmt = "0%"
  sheet.getCell("B4").value = { formula: "B2+B3", result: 1200.3 }
  ```

## `pond-lists.docx`

A 6.8 KB Word document with invented text, for the Word reader test in `src/readers/docx/index.test.ts`: a heading, a
bullet list with a nested item, a numbered list and a table with a header row and a Russian cell.

- **Made with** LibreOffice 26.2 headless from this HTML, once:

  ```sh
  echo '<html><body><h1>Synthetic pond report</h1><p>Herons counted this week:</p><ul><li>Grey heron</li><li>Night heron<ul><li>Juvenile</li></ul></li></ul><ol><li>Fill the pond</li><li>Count the fish</li></ol><table border="1"><tr><th>Bird</th><th>Count</th></tr><tr><td>Heron</td><td>42</td></tr><tr><td>Цапля</td><td>7</td></tr></table><p>Closing line.</p></body></html>' > lists.html
  soffice --headless --convert-to docx:"MS Word 2007 XML" lists.html
  ```

## `field-notes.docx`

An 11 KB Word document with invented text, for the same test: two footnotes, a line break inside a paragraph and a
table. pandoc writes it, so its parts differ from LibreOffice's.

- **Made with** `pandoc -o field-notes.docx field-notes.md` (pandoc 3), once, from:

  ```md
  # Synthetic field notes

  The heron returned to the pond[^1] before dawn.

  A second paragraph with a line··
  break and a tab-free ending.[^2]

  | Season | Herons |
  |--------|--------|
  | Spring | 12     |
  | Autumn | 42     |

  [^1]: The north pond, near the willow.
  [^2]: Counted by the synthetic observer.
  ```

  `··` stands for the two trailing spaces that make the line break.
