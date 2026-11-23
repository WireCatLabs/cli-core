### Added

- **`tokenSessionCommand` takes a `guide`**: how a person who never made one gets the token, step by step with its
  links. `session start` prints it before the question at a terminal and at the end of `session start --help`, never
  before piped input.
- **`plainSetupText`**: a setup text for a terminal, with `**`, code marks and `[words](link)` turned into plain words
  and the address. The terminal walk-through `<profile> setup` shows its texts that way, so a person no longer sees
  raw Markdown.
