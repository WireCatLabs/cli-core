import { CliError } from "@wirecat/cli-base"

export const GOOGLE_MAX_PAGES = 1000

/** One page of a Google list, its items under the name `items` whatever the API calls them. */
export interface GooglePage<T> {
  items?: readonly T[] | null
  nextPageToken?: string | null
}

/**
 * Every page of one Google list, following `nextPageToken`. A repeated page token or a list past `maxPages` is
 * Google's fault and stops the read with `invalid_response`, instead of looping forever.
 */
export const googlePages = async <T>(
  what: string,
  read: (pageToken?: string) => Promise<GooglePage<T>>,
  maxPages = GOOGLE_MAX_PAGES,
): Promise<T[]> => {
  const items: T[] = []
  const seen = new Set<string>()
  let pageToken: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const answer = await read(pageToken)
    for (const item of answer.items ?? []) items.push(item)
    if (!answer.nextPageToken) return items
    if (seen.has(answer.nextPageToken))
      throw new CliError("invalid_response", `Google repeated a page token of ${what}`)
    seen.add(answer.nextPageToken)
    pageToken = answer.nextPageToken
  }
  throw new CliError("invalid_response", `Google listed ${what} past ${maxPages} pages`)
}
