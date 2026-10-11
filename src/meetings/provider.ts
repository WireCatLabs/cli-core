import { CliError } from "@wirecat/cli-base"

export interface MeetingProviderScope {
  readonly provider: string
  readonly account: string
}

export const snapshotMeetingScope = (scope: MeetingProviderScope): Readonly<MeetingProviderScope> => {
  const provider = scope?.provider
  const account = scope?.account
  if (
    typeof provider !== "string" ||
    !provider.trim() ||
    provider.length > 200 ||
    /[\0\r\n]/.test(provider) ||
    typeof account !== "string" ||
    !account.trim() ||
    account.length > 1000 ||
    /[\0\r\n]/.test(account)
  )
    throw new CliError("validation_error", "meeting provider and account must be bounded nonempty identifiers")
  return Object.freeze({ provider, account })
}
