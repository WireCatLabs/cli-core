const SECRET_WORDS = new Set([
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "passphrase",
  "password",
  "secret",
  "token",
  "apikey",
])

// Undeclared flags carry no mark, so the name is the only signal; CLIs take secrets at a prompt (WC-SECR-5) and this
// catches the one typed anyway.
export const secretNamed = (name: string): boolean => {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .map((word) => word.toLowerCase())
  return words.some((word, at) => SECRET_WORDS.has(word) || (word === "api" && words[at + 1] === "key"))
}

const START = "(?<![A-Za-z0-9_-])"
const END = "(?![A-Za-z0-9_-])"

// Vendors print these prefixes so scanners can find their keys; a Stripe `pk_` key is public by design.
const KNOWN_TOKENS = new RegExp(
  `${[
    "gh[pousr]_[A-Za-z0-9]{36,}",
    "github_pat_[A-Za-z0-9_]{22,}",
    "sk-[A-Za-z0-9_-]{20,}",
    "xox[abprs]-[A-Za-z0-9-]{10,}",
    "(?:AKIA|ASIA)[A-Z0-9]{16}",
    "AIza[A-Za-z0-9_-]{35}",
    "(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}",
    "npm_[A-Za-z0-9]{36}",
    "eyJ[A-Za-z0-9_-]{5,}\\.eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]*",
  ]
    .map((pattern) => `${START}${pattern}${END}`)
    .join("|")}|(?<!\\d)\\d{8,10}:[A-Za-z0-9_-]{35}${END}`,
  "g",
)

const PRIVATE_KEY = /-----BEGIN[A-Z ]* PRIVATE KEY-----[\s\S]*?(?:-----END[A-Z ]* PRIVATE KEY-----|$)/g

// Capitalised, as in a header, and not followed by a plain word: "the Basic plan" is somebody's words.
const SCHEME = /(?<![A-Za-z])(Bearer|Basic)(\s+)(?![A-Z]?[a-z]+(?![A-Za-z0-9]))[A-Za-z0-9._~+/=-]{8,}/g

const NAMED_PAIR =
  /(?<![A-Za-z0-9])([A-Za-z0-9_.-]*(?:token|password|passphrase|secret|credential|cookie|authorization|api[_-]?key)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)((?:Bearer\s+|Basic\s+)?)([^\s"'&,;]+)/gi

/**
 * Whether a run of token characters is a random string rather than words: long, mixed case, high Shannon entropy,
 * cut into short pieces (`Kz9vQ2mX`) where a name is cut into words (`InlineQueryResultMpeg4Gif`).
 */
export const looksRandom = (run: string): boolean => {
  if (run.length < 20) return false
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((kind) => kind.test(run)).length
  if (classes < 3) return false
  let switches = 0
  for (let at = 1; at < run.length; at++) {
    const [before, after] = [run[at - 1] as string, run[at] as string]
    if ((/[a-z]/.test(before) && /[A-Z]/.test(after)) || (/[A-Z]/.test(before) && /[a-z]/.test(after))) switches += 1
  }
  if (switches / run.length < 0.15) return false
  const pieces = run.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? []
  if (pieces.join("").length / Math.max(pieces.length, 1) >= 2.75) return false
  return entropy(run) >= 3.5
}

const entropy = (text: string): number => {
  const counts = new Map<string, number>()
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) bits -= (count / text.length) * Math.log2(count / text.length)
  return bits
}

/**
 * Text with each secret inside it replaced by `mark` and the words around it kept: a token of a known vendor format,
 * a private key, a `Bearer`/`Basic` credential, the value of a secret-named `name=value` or `name: value`, and a
 * random-looking string of 20 or more printable characters (`looksRandom`).
 */
export const withoutSecrets = (text: string, mark = "[redacted]"): string =>
  text
    .replace(PRIVATE_KEY, mark)
    .replace(KNOWN_TOKENS, mark)
    .replace(SCHEME, `$1$2${mark}`)
    .replace(NAMED_PAIR, (whole, name: string, separator: string, scheme: string) =>
      secretNamed(name) ? `${name}${separator}${scheme}${mark}` : whole,
    )
    .replace(/[!-~]{20,}/g, (token) =>
      // A URL or a path is somebody's address, not a key; a credential in one is caught by the rules above.
      token.includes("://") || /^(?:\/|~\/|\.\.?\/)/.test(token)
        ? token
        : token.replace(RUN, (run) => (looksRandom(run) ? mark : run)),
    )

const RUN = /(?<![A-Za-z0-9_+/-])[A-Za-z0-9_+/-]{20,}/g
