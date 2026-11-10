### Added

- **`<tool> <profile> store import <file.json>` loads made-up chats, people and messages into a test store**, for
  WireCat Desktop's sandbox: Search and Analytics get messenger data without anyone signing in. The file is the
  adapter kit's `Seed` shape plus `"synthetic": true` (the format: the API reference, "Made-up data for a test store");
  it is written as a pushed sync writes, so the same file twice adds nothing and a changed message is updated in
  place. Without `--yes` it only says what it would load. It refuses a file not marked synthetic, the owner's real
  store (whatever `HOME` says), and a profile recorded as another account. New permission key `store.import`, `ask`.
