/**
 * What one meeting room is, whatever link it was shared by: `zoom:<number>`, `meet:<code>`, else the host and path.
 * A query string carries passcodes (`pwd=`), so it never reaches the key or a stored link.
 */
export const joinKeyOf = (url: string | null | undefined): string | null => {
  const parsed = urlOf(url)
  if (!parsed) return null
  const host = parsed.hostname.toLowerCase().replace(/^www\./u, "")
  const path = parsed.pathname.replace(/\/+$/u, "")
  if (host === "zoom.us" || host.endsWith(".zoom.us") || host === "zoomgov.com" || host.endsWith(".zoomgov.com")) {
    const number = /^\/(?:j|w|s|wc\/join|wc)\/(\d{9,12})(?:\/|$)/u.exec(path)?.[1]
    if (number) return `zoom:${number}`
  }
  if (host === "meet.google.com") {
    const code = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})$/iu.exec(path)?.[1]
    if (code) return `meet:${code.toLowerCase()}`
  }
  return `${host}${path}`
}

/** The link without its query string or fragment, which may hold a passcode. */
export const joinUrlWithoutQuery = (url: string | null | undefined): string | null => {
  const parsed = urlOf(url)
  return parsed ? `${parsed.origin}${parsed.pathname}` : null
}

const urlOf = (url: string | null | undefined): URL | null => {
  if (!url?.trim()) return null
  try {
    const parsed = new URL(url.trim())
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : null
  } catch {
    return null
  }
}
