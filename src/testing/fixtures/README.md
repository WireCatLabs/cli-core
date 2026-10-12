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

## `silero_vad.onnx`

The voice detector model the speech code downloads (`VAD` in `src/speech/models.ts`, same sha256), so
the test runs without a download. Silero VAD, MIT license — [`silero_vad.LICENSE`](silero_vad.LICENSE),
from [snakers4/silero-vad](https://github.com/snakers4/silero-vad).

## `legacy.doc`

A 9.5 KB Word 97–2003 document with invented text (English and Russian), for the `.doc` reader test in
`src/attachments/documents.test.ts`. Binary `.doc` cannot be built in a test without a writer library.

- **Made with:** `soffice --headless --convert-to doc legacy.txt` (LibreOffice), from a text file holding
  "Synthetic legacy memo", a blank line and "The heron count rose to 42 in October. Цапли вернулись."
