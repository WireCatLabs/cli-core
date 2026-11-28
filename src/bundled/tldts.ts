/**
 * tldts, bundled into `dist/bundled/tldts.js` by `scripts/bundle-libraries.ts`; import it from here. The
 * signatures are spelled out so the published declarations name no `tldts` type.
 */
import * as tldts from "tldts"

export const getDomain = (host: string): string | null => tldts.getDomain(host)

export const getDomainWithoutSuffix = (domain: string): string | null => tldts.getDomainWithoutSuffix(domain)
