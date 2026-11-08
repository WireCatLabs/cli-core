import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase } from "../driver.js"

const KEY = "ownerLanguages"

// A fixed list, not Intl.DisplayNames: a Node built with small-icu knows only English names, and the setting
// must be refused or accepted the same everywhere.
const ISO_639_1 = new Set(
  (
    "aa ab ae af ak am an ar as av ay az ba be bg bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en " +
    "eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv " +
    "ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne " +
    "ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st " +
    "su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu"
  ).split(" "),
)

/** Unset, the owner reads Russian, the same default as `AppIdentity.locale`, not the system's language. */
export const DEFAULT_OWNER_LANGUAGES: readonly string[] = ["ru"]

/** `ru, EN,ru` → `["ru", "en"]`: ISO 639-1 codes in the owner's order, each once. */
export const parseOwnerLanguages = (value: string): string[] => {
  const codes = value
    .split(/[\s,]+/)
    .map((one) => one.trim().toLowerCase())
    .filter(Boolean)
  const unknown = codes.filter((one) => !ISO_639_1.has(one))
  if (codes.length === 0 || unknown.length > 0)
    throw new CliError(
      "validation_error",
      `owner_languages takes ISO 639-1 language codes, the language the owner reads first first (ru,en) — ${
        unknown.length > 0 ? `not ${unknown.join(", ")}` : "at least one"
      }`,
    )
  return [...new Set(codes)]
}

/** What `config set owner_languages` saved; `undefined` while the default applies, or when a newer tool saved one. */
export const savedOwnerLanguages = (database: CacheDatabase): string[] | undefined => {
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(KEY)
  if (!row) return undefined
  try {
    return parseOwnerLanguages((JSON.parse(String(row.value)) as string[]).join(","))
  } catch {
    return undefined
  }
}

/**
 * The languages the owner reads, primary first: everything written for him is in the first; a title quoted in a
 * later one stays untranslated.
 */
export const ownerLanguages = (database: CacheDatabase): readonly string[] =>
  savedOwnerLanguages(database) ?? DEFAULT_OWNER_LANGUAGES

export const saveOwnerLanguages = (database: CacheDatabase, languages: readonly string[] | undefined, now: number) => {
  if (languages === undefined) {
    database.prepare("DELETE FROM store_settings WHERE key = ?").run(KEY)
    return
  }
  database
    .prepare(
      "INSERT INTO store_settings (key, value, at) VALUES (?, ?, ?) " +
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at",
    )
    .run(KEY, JSON.stringify(languages), now)
}
