/**
 * Machine-readable step lines: one JSON object per line on the diagnostic stream, only in `--json` / `--jsonl`, so
 * stdout keeps its single answer and a person at a terminal sees nothing new. Sign-in and `messages sync` share it.
 */
export const stepLines =
  (diagnostic: (line: string) => void, json: boolean) =>
  (event: Record<string, unknown> & { event: string }): void => {
    if (json) diagnostic(JSON.stringify(event))
  }
