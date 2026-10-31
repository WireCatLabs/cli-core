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

## `stereo.mp3`

One second of a two-channel MP3 at 8 kHz — a 440 Hz tone on the left, pink noise on the right — the shape of a
recorded phone call with one speaker per channel, for the channel test in `src/speech/decode.test.ts`:

```sh
ffmpeg -f lavfi -i "sine=frequency=440:duration=1:sample_rate=8000" \
  -f lavfi -i "anoisesrc=d=1:c=pink:r=8000:a=0.3:seed=1" \
  -filter_complex "[0:a][1:a]join=inputs=2:channel_layout=stereo[a]" -map "[a]" \
  -c:a libmp3lame -b:a 32k -map_metadata -1 stereo.mp3
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
