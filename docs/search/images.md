# Image search

Find a picture by what is around it and by what it shows. This guide is for people who use a tool built on
cli-core (`tg`, `max`, `memo`) and for developers who build on cli-core. Commands are written as `tg`; the other
tools take the same words.

The search runs on your machine. No picture, message or vector leaves it (see [Privacy](#privacy)).

## What it is

An image can be found three ways. Each one is a separate level and each one works without the others.

| Level | Finds an image by | Needs | On by default |
|---|---|---|---|
| 1. Context | the messages around it: up to 3 before and 3 after, within 10 minutes, plus the chat title and the sender | `conversations embed`, the text model | yes |
| 2. Caption | the words of its own caption | normal text search | yes |
| 3. Picture | what it shows | a picture model, `picture_search` on, `images embed` | no |

**Level 1, context.** Every image gets a text built from its neighbours, with or without a caption. The text is the
chat title, the earlier messages, the image line (`[photo]` and its caption) and the later messages, cut at 1,200
characters. An image with no caption and no neighbouring text gets no context text. The text is embedded with the
normal text model, `e5-small` by default, in the same run that embeds conversations. Each image has one chunk of
type `image` at position 0.

**Level 2, caption.** The caption is the message text. `search messages` finds it like any other word. See the
[query language](query-language.md).

**Level 3, picture.** The model CLIP ViT B/32 (`Xenova/clip-vit-base-patch32`, 8 bit, model key
`local:clip-b32:512`) turns each picture into a vector of 512 numbers. Its own text side turns your query into a
vector of the same kind. The closest pictures win. A picture vector is a second chunk of the image, at position 1.
This level finds photos that have no text at all.

The text side of this model understands English only. Write the query in English, or have an agent translate it
before it searches.

### Pictures are their own result lane

Level 3 hits are not mixed into the text ranking. In `search messages` they come as extra items after the text
hits, each marked `matched_in: "picture"`, and only on the first page. A message already in the text hits is not
listed twice. The text order never changes because of them.

They are separate because a merge scored lower in the benchmark (see [Quality and cost](#quality-and-cost)).

## Set up level 3

Level 3 is off until you turn it on. Do the four steps once per profile.

```sh
tg work config set picture_search true
tg work images models download clip-b32
tg work images embed
tg work search messages "a red bicycle leaning on a wall"
```

1. **Turn it on.** `picture_search` is a per profile setting, false until set. `config set picture_search true`
   writes it to the profile. Without it, `images embed` stops with an error that says picture search is off, and
   `search messages` adds no picture items.
2. **Download the model.** `images models download clip-b32` fetches four files from Hugging Face and checks each
   against a fixed sha256. The vision file is about 89 MB and the text file about 65 MB. The command then loads
   the model once to check that it works. Files are kept in the shared models folder, in `models/image`, so every
   tool on the machine uses one copy. `images models list` shows which models exist, which are downloaded and
   which is the default.
3. **Compute the vectors.** `images embed` goes through the images the store knows and has no picture vector for.
   For each one it reads the bytes, computes the vector, keeps the vector and a sha256 of the bytes, and drops
   the file. Options:
   - `--chat <chat>` only this chat.
   - `--limit <n>` at most this many pictures in one run. The default is 100.

   It works one picture at a time with a short pause, saves in small groups, and marks nothing read. Run it
   again to go on: an image with a vector is not read twice. When the limit came first, the output says there are
   more.
4. **Search.** `search messages` now returns the picture lane beside the text hits.

The bytes come from the saved copy of the attachment when there is one and it is not over 25 MB. Otherwise they
come from the messenger's own download, held in memory, with the same 25 MB cap. A picture that is too large, or
that the messenger no longer gives back, is counted as `skipped`.

Level 1 needs no setup beyond the text model. Run `tg work conversations embed --chat <chat>` (or without
`--chat` for every built chat). The image texts are embedded in the same run. `search conversations` then returns
an image found by its context as a hit marked `matched_in: "context"`.

## Search examples

```sh
tg work search messages "sunset over the sea"
tg work search messages "a whiteboard with a diagram" --chat family
```

Rules for the picture lane in `search messages`:

- It reads the plain words of the query. Fields (`from:`), operators (`AND`, `NOT`), quotes and brackets are
  removed first. A query with no plain words has no picture lane. Words inside `text:`, `content:`, `transcript:`
  and `filename:` are kept.
- `--chat` narrows it to one chat.
- It is skipped for mail, for `--discover`, for pattern queries, and for the second page and later.
- It returns at most 5 pictures.
- A failure in the lane is a note, not a failed search.

In `search notes`, pass `pictures: true` from code (see [For developers](#for-developers)).

### Output

In machine mode the answer is the usual envelope, with snake_case fields. A picture hit is an item with this
shape:

```json
{
  "items": [
    {
      "ref": "<locator of the message>",
      "timestamp": "2026-03-02T10:15:00.000Z",
      "sender_name": "Sender",
      "matched_in": "picture",
      "score": 0.31
    }
  ],
  "page": 1,
  "meta": { "accounts": [] }
}
```

`ref` is the message locator. Use it with `messages context` and the attachment commands. `score` is cosine
similarity, 4 decimals. The envelope also carries `next` and `missing` entries when something is not ready; see
[Troubleshooting](#limits-and-troubleshooting).

`images embed` prints one line in pretty mode, for example `12 pictures embedded with local:clip-b32:512`, with
the counts of pictures not readable and failed when there are any. In machine mode it returns the same numbers:
`model`, `embedded`, `skipped`, `failed` and `more`.

`images models list` returns one item per model with `id`, `kind` (`image`), `title`, `languages`, `licence`,
`size_bytes`, `downloaded`, `default` and `path`.

## Permissions

- `images models list` and `images models download` are housekeeping. They need no permission.
- `images embed` is checked as `conversations.embed`, the same key as `conversations embed`. It reads pictures from
  the messenger and writes vectors to the local store only. Unless the profile sets `permissions.conversations.embed` to allow, it is refused, or
  asks for confirmation. The error names the `config set permissions.conversations.embed allow` command to use.

## Privacy

- The model runs on your machine. Picture vectors and image context vectors stay in the local store.
- `images embed` fetches picture bytes from the messenger, the same download `attachments` uses. It does not
  send anything out, marks nothing read, and keeps no file: only the vector and a sha256. When `serve` holds the
  messenger's connection, the command runs inside `serve`, which does the downloads.
- The only network use of level 3 is the one time model download from Hugging Face.
- Level 1 uses whatever text model `conversations embed` is told to use. The default is local. With
  `--embedding-provider`, the chunk texts, which include the image context texts, go to that service. Keep the default
  when the chats are private.

## Quality and cost

The benchmark used 150 photos from one personal Telegram account and 30 queries, one per target photo. The
numbers are in [cli-testing, performance/search/images](https://github.com/WireCatLabs/cli-testing/tree/main/performance/search/images).

MRR (mean reciprocal rank) is the average of 1 divided by the position of the right photo in the results, so
1.0 means it is always first and 0.5 means it is on average second.

| Lane | MRR |
|---|---|
| Caption only | 0.39 |
| Context (level 1) | 0.55 |
| CLIP B/32 with a multilingual text side, Russian queries | 0.86 |
| SigLIP2, Russian queries | 0.66 |
| CLIP B/32 with its own English text side, English queries | 0.93 |
| Text lane and picture lanes merged by reciprocal rank fusion | 0.77 |

The shipped model is the English one, the 0.93 row. The 0.86 row used a different, multilingual text encoder that
cli-core does not ship. The merge scored below the picture lane alone, which is why picture hits stay a separate
lane.

On targets with no caption, caption search found almost nothing (MRR 0.01), context reached 0.51 and the picture
model 0.83 with the multilingual text side.

Cost in that benchmark: about 57 ms per picture and about 33 ms per English query (median), on a laptop CPU with the models on disk.

Not measured: the time and the cost of embedding a whole library, and index size on disk. The benchmark is one
person's 150 photos, many of them screenshots. A gap of one or two queries is noise.

## Limits and troubleshooting

- **English only at level 3.** A query in another language matches poorly. Translate it first.
- **No picture items at all.** Check, in order: `picture_search` is true for this profile, the model is
  downloaded (`images models list`), and `images embed` has run for the chat. Until then there is nothing to
  compare.
- **`pictureSearch` off.** `images embed` fails with a message that picture search is off for the profile. Run
  `config set picture_search true`.
- **Model not downloaded.** `search messages` still returns the text hits. It adds a `next` step
  (`images models download clip-b32`) and a `missing` entry for the field `pictures`. In pretty mode it does not
  print a separate note for this case.
- **Nothing was embedded yet.** The lane is empty. Run `images embed`, repeatedly, until the output no longer says
  there are more.
- **The floor hides weak matches.** A picture needs a score of at least 0.25 (`PICTURE_FLOOR`). In the benchmark
  every right match scored 0.25 or more, and unrelated pictures had a median of 0.19 and 0.27 at the 99th
  percentile. A real but weak match can still be cut. Describe what is visible, in plain concrete words.
- **Skipped pictures.** Over 25 MB, deleted on the server, or no file given back. They count as `skipped` and are
  tried again on the next run.
- **Queries about context, not looks.** "The photo he sent about the contract" is a level 1 question. Use
  `search conversations`.

## For developers

### Where the code is

| Path | What it holds |
|---|---|
| `src/images/context/index.ts` | the level 1 provider: window constants and the context text |
| `src/images/registry.ts` | the image provider registry, `registerImageProvider` |
| `src/images/picture/models.ts` | the picture model catalog `IMAGE_MODELS`, `DEFAULT_IMAGE_MODEL`, model folder |
| `src/images/picture/embedder.ts` | `openPictureEmbedder`: vision and text sessions, loaded on first use |
| `src/images/picture/preprocess.ts` | picture bytes to model input |
| `src/services/pictures.ts` | `picturesService` (`embed`, `lane`), `withPictures`, `PICTURE_FLOOR`, `PICTURE_MAX_BYTES`, `plainWords` |
| `src/services/embeddings-maintenance.ts` | embeds image context texts in the `conversations embed` run |
| `src/services/embeddings-search.ts` | merges context image hits into `search conversations` |
| `src/services/document-pictures.ts` | `savePicture`, `removePicture`, `openPictureEmbedderFor` |
| `src/services/notes-search.ts` | `searchNotes` with `pictures: true` |
| `src/store/sqlite/image-chunks.ts` | image chunks of messages: save, find, nearest |
| `src/store/sqlite/document-pictures.ts` | picture chunks of documents |
| `src/cli/messenger/images-command.ts`, `models-command.ts` | `images embed`, `images models` |
| `src/sends/permissions.ts` | the permission keys |

### Data layout

Two tables carry everything, in the store's SQLite file.

- `chunks`: one row per piece of content. The key is `(chunkable_type, chunkable_id, position)`.
  - A message image: `chunkable_type = 'image'`, `chunkable_id` is the attachment id. Position 0 is the context
    text, position 1 (`PICTURE_POSITION`) is the picture.
  - A document picture: `chunkable_type = 'document_picture'`, `chunkable_id` is the document id, position 0.
    The entity type `document_picture` belongs to `documents`.
- `embeddings`: one row per `(model, content_hash)`, with `dims` and the vector blob. The chunk's `content_hash`
  points to it. For a picture, the hash is the sha256 of the picture bytes. For a context text it names the
  provider and its version, so a new provider version describes every image again.

A model's vectors only sit at one position: the text model's at 0, `local:clip-b32:512` at 1. A vector row is
dropped when no chunk uses its hash any more.

### The image provider registry

Level 1 is the built in provider `context`. A provider has an `id`, a `version` and `describe(image, context)`
that returns text. Providers run in order and the first one that gives text describes the image.
`registerImageProvider(provider, { before })` adds one or replaces the one with the same id, and returns a
function that removes it. Bumping `version` makes `conversations embed` describe every image again.

### Picture models

`IMAGE_MODELS` in `src/images/picture/models.ts` is a list, and `imageModel(id)` and `images models` read from it.
An entry names the files with their sha256 and sizes, the vision and text files, `dims`, `maxTokens` and the
vector key `<provider>:<model>:<dims>`. Only `clip-b32` exists. Picture search itself always uses
`DEFAULT_IMAGE_MODEL` (`picturesService`, `savePicture` and `searchNotes` call `imageModel(DEFAULT_IMAGE_MODEL)`),
so adding an entry to the list makes it downloadable but does not make search use it.

### Documents

Documents get one picture chunk. These exports come from `@wirecat/cli-core/services`:

- `openPictureEmbedderFor({ env, command })` opens the model, or throws `not_found` with
  `reason: "model.not-downloaded"` and the command that downloads it. Close the embedder when done.
- `savePicture(store, target, bytes, options)` gives a document the vector of its picture. `target` is
  `{ ref: "document:<id>" }` or `{ documentId }`. The same bytes as last time cost nothing, because only the
  sha256 is compared; other bytes replace the vector. It resolves `"saved"` or `"unchanged"`. Pass
  `options.embedder` to reuse one open model across many documents. Nothing of the file is kept.
- `removePicture(store, target)` drops the picture chunk and its vector. It resolves false when the document had
  none. The store also drops it when a document is no longer live.
- `searchNotes(store, query, { pictures: true, pictureLimit })` adds `pictures` (`{ ref, score }`, best first,
  floor 0.25) beside the hits. It is never mixed into `hits`. A missing model gives `pictures_skipped`, not an
  error. The query is reduced to plain words, as above. Pass `pictureEmbedder` to reuse an open model.

The caller chooses which documents are pictures and fetches their bytes. cli-core only embeds the bytes it is given.

### Messages

`services.pictures.embed({ chat, limit, signal })` and `services.pictures.lane(query, { chat, since, limit })` are
what the CLI calls. `withPictures` wraps the messages service so that `search` returns the lane as `pictures`,
`picturesSkipped` and `picturesModel` beside its hits. The service gets `deps.pictures` from the profile setting,
and `deps.pictureEmbedder` lets a test give a fake model.
