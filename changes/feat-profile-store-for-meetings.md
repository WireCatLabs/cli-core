### Added

- **`openProfileStore` for a phone system's calls**, exported from `@wirecat/cli-core/cli` with `ProfileStore` and
  `ProfileStoreOptions`, so asterisk-cli and beeline-cli drop their own copies.
  - It also answers `accountId`, the store's id for the account, which `store.meetings({ accountId })` takes.
  - `account` is optional. Without it the account is the profile itself (`{ provider, account: profile }`), and a
    read finds an account an older build saved with no profile row, under `<PREFIX>_READ_ONLY` too.
  - `saves: false` never saves the account. A profile no run saved, or no store at all, reads an empty store in a
    temporary folder, so a mistyped profile saves nothing. A store that needs a migration is still migrated.
  - `name` is the name a new account is saved with. It was always `null`.
  - A CRM's and a content CLI's calls (`openCrmStore`, `openContentStore`) work as before.

### Fixed

- **`session list` warns once when the keyring cannot be reached**, not once per profile, as 1.1.0 described. The
  warning was counted by its text, and cli-base's text names the profile.
- **Parity checks bitrix24, tg, max and whatsapp again.** The 1.3.0 release run passed their tests. tg, max and
  whatsapp adopted `session list` and `session status` (tg-cli#923, max-cli#992, whatsapp-cli#423), and bitrix24's
  `src/mcp.test.ts` no longer pins `schedule exec`.
