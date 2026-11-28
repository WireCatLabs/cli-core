/// <reference path="../types/psl.d.ts" />
/**
 * psl, bundled into `dist/bundled/psl.js` by `scripts/bundle-libraries.ts`; import it from here. It stays beside
 * tldts because the two lists disagree on some hosts, and `siteOf` answers are stored.
 */
import psl from "psl"

export type Parsed = { domain: string | null; listed: boolean } | { error: { code: string; message: string } }

export const get = (domain: string): string | null => psl.get(domain)

export const parse = (input: string): Parsed => psl.parse(input)
