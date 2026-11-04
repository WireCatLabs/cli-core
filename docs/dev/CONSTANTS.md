# Constants

Values that ship inside the packages and are the same for every owner. They are not settings: the owner's
`~/.config/<tool>/config.json` holds choices and never a secret, while a constant is fixed by the release.

## What lives here

[`constants.json`](../../constants.json) at the package root, listed in `files`:

| Key | What it is |
|---|---|
| `google.app.client_id`, `google.app.client_secret` | WireCat's Google Desktop OAuth app. Google treats a Desktop app's secret as public ([native apps](https://developers.google.com/identity/protocols/oauth2/native-app)); both values are stored obscured and revealed by the schema (`src/constants/obscure.ts`), which keeps secret scanners from reporting them. It is not protection: anyone with the package can reveal them |
| `microsoft.app.client_id` | WireCat's Microsoft Entra public client, which sends no secret |

## Layer order

`constants(toolLayer?, schema?)` from `@wirecat/cli-core/constants` calls cli-base's `loadConstants` with cli-base's
`constants.json`, then this one, then the tool's. Plain objects merge key by key and a later layer wins; an array or a
scalar replaces what was below it; a missing file is an empty layer. The result is validated, frozen, and read once
per process for each tool layer.

## How a tool adds its layer

A tool keeps a `constants.json` at its package root, lists it in `files`, and passes it with a schema built on
`constantsSchema`:

```ts
const schema = v.object({ ...constantsSchema.entries, zoom: v.object({ app: v.object({ client_id: v.string() }) }) })
const shipped = constants(new URL("../constants.json", import.meta.url), schema)
```

The URL is relative to the compiled module that names it; `cli-dev bundle` keeps `import.meta.url` there. The first
call for a layer decides its schema.

## Sign-in apps

`googleApp({ env, prefix, clientFile })` returns `{ client, source }`: the owner's `--client-file` (`file`, read with
`readClientFile`, which refuses a file others can read), else `<PREFIX>_GOOGLE_CLIENT_ID` with an optional
`<PREFIX>_GOOGLE_CLIENT_SECRET` (`env`; a secret alone is a `configuration_error`, reason
`sign-in.secret-without-id`), else WireCat's app (`wirecat`). A tool whose layer overrides the app passes its
`constants`. Microsoft has no helper: mail's own app comes from its per-mailbox setting, so mail reads
`constants().microsoft.app.client_id` as its fallback.
