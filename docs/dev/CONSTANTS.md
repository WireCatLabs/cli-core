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

The app a sign-in uses follows [WC-SECR-25](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/security.md#wc-secr-25--sign-in-with-wirecats-app-by-default-and-let-the-owner-choose-their-own),
first match wins:

| `source` | Where the app comes from |
|---|---|
| `flag` | `--client-file` (Google only, read with `readClientFile`, which refuses a file others can read) or `--client-id` |
| `env` | `<PREFIX>_<PROVIDER>_CLIENT_ID`, such as `GCAL_GOOGLE_CLIENT_ID` |
| `config` | the account's config key `<provider>.client_id`, which the tool reads and passes as `configClientId` |
| `constants` | WireCat's app from `constants.json` |

A secret, where the provider needs one, always comes from `<PREFIX>_<PROVIDER>_CLIENT_SECRET` and pairs with the id
found by `flag`, `env` or `config`; a config file never holds it. A secret with no id is a `configuration_error`,
reason `sign-in.secret-without-id`.

- `googleApp({ env, prefix, clientFile?, clientId?, configClientId?, platform?, constants? })` → `{ client, source }`.
- `microsoftApp({ env, prefix, clientId?, configClientId?, constants? })`: WireCat's Microsoft app has no secret.
- `oauthApp({ provider, env, prefix, clientId?, configClientId?, wirecat? })`: any provider, with WireCat's app from
  the tool's layer; `undefined` when nothing names an app and `wirecat.client_id` is empty.
- `oauthClientReport(app, reason?)` → `doctor`'s `oauth_client`, `{ client: "wirecat" | "own" | null, source,
  reason? }`. Pass the signed-in entry's `client` when it has a `source`, else the app a new sign-in would use.

`client` carries its `source`, and the standard and drive sign-in entries save it as `clientSource`, so refresh,
revoke and `doctor` see the app the account signed in with.
