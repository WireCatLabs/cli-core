### Fixed

- **`changes` takes `--since <time>` and `--until <time>`**, the vocabulary's value name, where it said `<when>`. With
  cli-base 0.129.0, which adds the `changes` view, `--since` and `--event`, the shared history commands pass
  `cli-dev lint` in a documents CLI with no override. The flags take the same values as before.
