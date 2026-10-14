import { CliError } from "@wirecat/cli-base"
import type { SearchQuery } from "./messages.js"

export const validateSearchDialect = (request: SearchQuery): void => {
  const { pattern } = request
  if (request.language !== undefined && !["lucene", "legacy"].includes(request.language))
    throw new CliError("validation_error", "--language takes lucene or legacy")
  if (pattern && (request.language === "lucene" || request.ast !== undefined || request.timezone !== undefined))
    throw new CliError("validation_error", "--regex is legacy JavaScript mode; not with Lucene, AST or timezone")
  if (request.language === "legacy" && (request.ast !== undefined || request.timezone !== undefined))
    throw new CliError("validation_error", "AST and timezone require the Lucene language")
  if (pattern && (request.source !== undefined || request.accounts !== undefined || request.senders !== undefined)) {
    throw new CliError(
      "validation_error",
      "--regex reads the account it runs as — not with --source, other accounts or senders",
    )
  }
}
