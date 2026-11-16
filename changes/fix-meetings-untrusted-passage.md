### Security

- **`passageForRun(command, result, format)`** (`@wirecat/cli-core/cli`) gives a host the `meetings passage` answer
  as it should print it. In a scheduled agent's run, the text and Markdown are formatted again from the cues with the
  run's untrusted marks around each speaker name and line, as JSON already had them. Outside such a run, and for
  JSON, the answer is unchanged. A host prints its `content` from the passage command's `output`.
