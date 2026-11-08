# Removing an account

`<tool> <profile> account remove --keep-data|--delete-data` signs a profile out and forgets it on this computer.
cli-core builds the command once (`src/cli/account-remove.ts`); a tool opts in by handing it hooks. This page is for a
tool's author: what the command does, and what each hook must do.

## What the command does

In this order, and stopping at the first failure:

1. **Refuses** without exactly one of `--keep-data` and `--delete-data` (`account-remove.no-choice`): the tool never
   decides for the owner what happens to the data. A profile this computer does not have is `not_found`
   (`account-remove.unknown-profile`). A `serve` running for the profile (its lock in `state/serve/<profile>.lock`),
   an active serve unit, an `mcp serve --http` for the profile, or whatever the tool's `busy` hook names, is
   `conflict` (`account-remove.busy`).
2. **Plans** every keyring entry, config section, file and store account it would remove, and every one it keeps.
   A path a hook names outside the tool's own config, state or cache folder, or the folders its `ownFolders` hook
   names, stops the command before anything is removed (`account-remove.path-outside`); an `ownFolders` folder that is
   not absolute and inside the home folder stops it too (`account-remove.folder-outside`). `--dry-run` answers the
   plan and changes nothing.
3. **Asks**, or takes `--yes`. Under `--json` without `--yes` it answers `confirmation_required`
   (`account-remove.unconfirmed`); nobody is signed out.
4. **Signs out** with the tool's `signOut`. If it throws, nothing is forgotten.
5. **Forgets**: the keyring entries from `secrets`, the profile's sections in the config file, the tool's
   `stateFiles`, and what cli-core itself keeps for the profile, so no tool lists it:
   - files: `accounts/`, `flood/`, `pace/`, `provider-log/`, `mcp-http/` (with its lock), `serve/<profile>.log`, a
     stale serve lock, `profiles/<profile>.recipients.json` and `.moderation.json`, `<profile>.replies-state.json`, the
     replies rules and consents in the config folder, the `--new` points (`inbox`, `review`, `mentions`, their `mcp-`
     and `schedule-<name>-` copies) and `checkpoints/<profile>/`;
   - the profile's serve unit, by its exact name, disabled and deleted as `server uninstall` does;
   - every schedule whose environment names the profile, as `schedule remove` does: its timer and its file go, its past
     output stays.

   The sends journal `sends/<profile>.jsonl` always stays, under `kept`: it is the record of what was sent. Other
   profiles are never touched.
6. **With `--delete-data`**: purges the account from the shared store (`store.accounts.purge`, which keeps people
   another account also saw) and forgets which account the profile was (`store.accounts.forgetProfile`), then deletes
   the tool's `dataFiles`. **With `--keep-data`** the store is not touched: the account's messages stay, and search
   still finds them; the answer lists them under `kept`.

The command is a remote write that logs out (`logsInOrOut`): `<PREFIX>_READ_ONLY` refuses it, serve never relays it,
and it is not an MCP tool (`mcp: false`).

## The answer

`--json` answers the entity `account_removal`:

```json
{
  "item": {
    "profile": "personal",
    "data": "kept",
    "dry_run": false,
    "account": { "provider": "telegram", "account": "500" },
    "revoked": null,
    "config_file": "/home/owner/.config/tg-cli/config.json",
    "removed": [
      { "kind": "sign_in", "target": "the Telegram session" },
      { "kind": "keyring", "target": "app-keys:personal" },
      { "kind": "config", "target": "profiles.personal" },
      { "kind": "file", "target": "/home/owner/.local/state/tg-cli/accounts/personal.json" }
    ],
    "kept": [
      { "kind": "store", "target": "telegram:500", "reason": "--keep-data: its messages stay in the store, and search still finds them" }
    ]
  }
}
```

`kind` is one of `sign_in`, `keyring`, `config`, `file`, `store`, `unit` (a path), `schedule` (a name). Under `--dry-run`, `removed` is what would go. A
keyring entry a run with moved folders could not remove is under `kept` with its reason.

## Adopting it

A messenger sets `accountRemoval` on its `Messenger`; `accountCommand` then adds `account remove`. Any other CLI mounts
the command under its own `account` group, inside `run()`:

```ts
import { accountRemoveCommand, type AccountRemoval } from "@wirecat/cli-core/cli"

const removal: AccountRemoval = {
  signOut: async (profile, { mayRevoke }) => {
    const { revoked } = await keeperFor(profile).signOut({ revoke: mayRevoke })
    return { revoked, removed: ["the Google sign-in"] }
  },
}

new Command("account").addCommand(accountRemoveCommand(app, removal, { provider: "google" }))
```

## The hooks

Every hook gets `{ env, keyring, mayRevoke }`. `keyring` is the run's (a test's `memoryKeyring()`); `mayRevoke` is
false in a run with moved folders, which shares the owner's keyring entry and must not take back the owner's sign-in
at the provider ([WC-SECR-24](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/security.md#wc-secr-24--a-run-with-moved-folders-shares-the-owners-keyring-entry-and-never-deletes-it)).

| Hook | Required | What it does |
| --- | --- | --- |
| `signOut(profile, context)` | yes | The tool's own sign-out: end the session at the provider, delete the token or device keys, revoke when `mayRevoke`. Answers `{ revoked, removed }`: `revoked` is `null` when the tool does not revoke, `removed` names what went in words the owner knows. A throw stops the removal. |
| `account(profile, context)` | no | The profile's `AccountKey` in the store. Unset: what `rememberAccount` recorded, read with the `provider` option. Without either, `--delete-data` keeps the store and says why. |
| `secrets(profile, context)` | no | Keyring entries the sign-out leaves, as `{ credentials, accounts }`: the `CredentialsOptions` the tool reads them with, and the account names. Removed through cli-base's `Credentials`, which never removes the owner's entry in a moved run. |
| `stateFiles(profile, context)` | no | The tool's own per-profile files and folders that hold no messages: cursors, device ids, a recipient list. Always removed. |
| `dataFiles(profile, context)` | no | Per-profile files and folders that hold the account's data outside the store: downloads, an archive. Removed only with `--delete-data`. |
| `forgetConfig(profile, context)` | no | For a tool that keeps its own config file: removes the profile there and answers what it removed. Unset: cli-core removes `personal.profiles.<profile>` and `profiles.<profile>` from the file `settingsFor` reads, keeping `profiles.<profile>` while a bot section uses it. |
| `busy(profile, context)` | no | What holds this profile now beyond a serve, such as a sync, in words for the refusal. |
| `ownFolders(context)` | no | Folders the tool keeps outside the ones its cli-core identity names, where its hooks' paths may also lie: zoom's `~/.config/zm` and `~/.local/share/zm`. Each must be absolute and inside the home folder. |

Every path must lie inside the tool's config, state or cache folder (`resolvePaths`), or a folder `ownFolders` names. Media the owner moved to a folder
of their own is not the tool's to delete.
