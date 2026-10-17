/** One address found in a text: a street word, a name and a house number, the postcode beside it if any. */
export interface FoundPlace {
  start: number
  end: number
  /** Lower-case, the street word written out in full: `ул. Ленина, д. 5` → `улица ленина 5`. */
  value: string
  confidence: number
}

// A street word before its name, with the full word it stands for. Written in any case: «на улице Ленина 5».
const BEFORE: [RegExp, string][] = [
  [/^(?:ул\.?|улиц[аеыу]|улицей)$/iu, "улица"],
  [/^(?:пр-т|просп\.?|проспект[аеу]?)$/iu, "проспект"],
  [/^(?:пер\.?|переул(?:ок|ке|ка))$/iu, "переулок"],
  [/^(?:наб\.?|набережн(?:ая|ой|ую))$/iu, "набережная"],
  [/^(?:б-р|бульвар[аеу]?)$/iu, "бульвар"],
  [/^(?:пл\.?|площад[ьи])$/iu, "площадь"],
  [/^(?:ш\.|шоссе)$/iu, "шоссе"],
  [/^(?:calle|c\/|cl\.?|carrer)$/iu, "calle"],
  [/^(?:avda\.?|avenida|avinguda|av\.?)$/iu, "avenida"],
  [/^(?:plaza|pza\.?|plaça|praça|piazza|plac)$/iu, "plaza"],
  [/^(?:paseo|passeig|p[ºo]\.)$/iu, "paseo"],
  [/^(?:camino|carretera|ctra\.?|ronda|travesía|travessa|glorieta|alameda|estrada|largo)$/iu, ""],
  [/^(?:rue|r\.)$/iu, "rue"],
  [/^(?:boulevard|bd|blvd\.?|bulevardul)$/iu, "boulevard"],
  [/^(?:avenue|allée|chemin|quai|impasse|route)$/iu, ""],
  [/^(?:via|viale|corso|vicolo|piazzale)$/iu, ""],
  [/^(?:ul\.?|ulica)$/iu, "ulica"],
  [/^(?:rua|aleja|al\.|strada|str\.|calea)$/iu, ""],
]
// After the name: Невский проспект 28; Berliner Straße 12.
const AFTER: [RegExp, string][] = [
  [/^(?:проспект|пр\.|пр-т)$/iu, "проспект"],
  [/^(?:переулок|пер\.)$/iu, "переулок"],
  [/^(?:набережная|наб\.)$/iu, "набережная"],
  [/^(?:бульвар|б-р)$/iu, "бульвар"],
  [/^(?:шоссе|ш\.)$/iu, "шоссе"],
  [/^(?:straße|strasse|str\.)$/iu, "straße"],
  [/^(?:weg|allee|platz|gasse|ring|damm|ufer|chaussee)$/iu, ""],
]
// Fused into the name: Hauptstraße 5, Kalverstraat 12, Nørregade 3.
const FUSED =
  /^\p{Lu}\p{Ll}+(?:straße|strasse|str\.|weg|allee|platz|gasse|damm|straat|laan|plein|gracht|kade|singel|vej|gade|gatan|vägen|veien|gate)$/u
// English streets come after the name and the number before it: 221B Baker Street.
const ENGLISH: [RegExp, string][] = [
  [/^(?:street|st\.?)$/i, "street"],
  [/^(?:road|rd\.?)$/i, "road"],
  [/^(?:avenue|ave\.?)$/i, "avenue"],
  [/^(?:lane|ln\.?)$/i, "lane"],
  [/^(?:drive|dr\.?)$/i, "drive"],
  [/^(?:boulevard|blvd\.?)$/i, "boulevard"],
  [/^(?:place|pl\.?)$/i, "place"],
  [/^(?:court|ct\.?)$/i, "court"],
  [/^(?:square|sq\.?)$/i, "square"],
  [/^(?:parkway|pkwy\.?)$/i, "parkway"],
  [/^(?:highway|hwy\.?)$/i, "highway"],
  [/^(?:circle|cir\.?)$/i, "circle"],
  [/^(?:way|close|crescent|terrace|gardens|grove|hill|row|mews|walk|trail)$/i, ""],
]

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}'’ºª.\-/]*/gu
const NUMBER = /^\d{1,5}(?:[a-zа-я]\d{0,2})?(?:[-/]\d{1,4}[a-zа-я]?)?$/iu
const NUMBER_WORD = /^(?:д\.?|дом|n[º°o]\.?|n\.º|núm\.?|nr\.?|no\.)$/iu
const ORDINAL = /^\d{1,2}(?:-?(?:я|й|го|ая|ий|ой)|º|ª|th|st|nd|rd)?$/iu
const LINK_WORD =
  /^(?:de|del|dels|des|du|di|da|do|dos|das|della|delle|van|von|der|den|la|le|les|el|l'|d'|y|i|the|of|and|имени|им\.)$/iu
const NAME = /^[\p{Lu}][\p{L}'’.-]*$/u
const AFTER_NUMBER = /^(?:кв\.?|корп\.?|к\.|стр\.?|оф\.?|лит\.?|piso|puerta|esc\.?|apt\.?|suite|unit|flat)$/iu
const POSTCODES = [
  /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b/, // GB
  /^[A-Z]{2}(?: US)? \d{5}(?:-\d{4})?\b/, // US state and ZIP
  /^\d{5}(?:-\d{4})?\b/, // US, ES, DE, FR, IT
  /^\d{6}\b/, // RU
  /^\d{4} ?[A-Z]{2}\b/, // NL
  /^\d{2}-\d{3}\b/, // PL
  /^\d{4}-\d{3}\b/, // PT
  /^[A-Z]{1,2}-\d{4,5}\b/, // LU, CH, AT with the country letter
  /^\d{4}(?= \p{Lu}\p{Ll})/u, // CH, AT, BE, DK, NO before the city
]

interface Token {
  text: string
  start: number
  end: number
}

// A full stop stays on an abbreviation (ул., Ave.) and leaves a number or a word that ends a sentence.
const tokensOf = (text: string): Token[] =>
  [...text.matchAll(TOKEN)].map((match) => {
    const trimmed = match[0].replace(/-+$/, "")
    const word = /^(?:\d+|\p{L}{5,})\.$/u.test(trimmed) ? trimmed.slice(0, -1) : trimmed
    return { text: word, start: match.index, end: match.index + word.length }
  })

const typeOf = (table: [RegExp, string][], word: string): string | undefined => {
  for (const [pattern, full] of table) if (pattern.test(word)) return full || word.toLowerCase()
  return undefined
}

// Words of a street's name, up to five, joined by spaces only: a comma ends the name. A number starts it only as
// an ordinal before a word (ул. 8 Марта, 5th Avenue); after a word it is the house number.
const nameRun = (tokens: Token[], from: number, text: string, step: 1 | -1, most = 5): number[] => {
  const taken: number[] = []
  for (let at = from; at >= 0 && at < tokens.length && taken.length < most; at += step) {
    const token = tokens[at] as Token
    const neighbour = tokens[at - step] as Token
    const gap = text.slice(Math.min(neighbour.end, token.end), Math.max(neighbour.start, token.start))
    if (gap !== " ") break
    const beforeName = NAME.test(tokens[at + 1]?.text ?? "")
    if (
      NAME.test(token.text) ||
      LINK_WORD.test(token.text) ||
      (taken.length === 0 && ORDINAL.test(token.text) && beforeName)
    )
      taken.push(at)
    else break
  }
  while (taken.length > 0 && LINK_WORD.test(tokens[taken.at(-1) as number]?.text ?? "")) taken.pop()
  if (taken.every((at) => LINK_WORD.test(tokens[at]?.text ?? ""))) return []
  return step === 1 ? taken : taken.reverse()
}

// The house number after the name: «, д. 5», « 12», «, nº 3»; and what follows it: «, кв. 7».
const numberAfter = (tokens: Token[], at: number, text: string): { number: string; last: number } | undefined => {
  let next = at + 1
  const gapOk = (from: Token, to: Token) => /^[ ,]{1,2}$/.test(text.slice(from.end, to.start))
  const previous = tokens[at]
  let word = tokens[next]
  if (!previous || !word || !gapOk(previous, word)) return undefined
  if (NUMBER_WORD.test(word.text)) {
    const number = tokens[next + 1]
    if (!number || !/^ ?$/.test(text.slice(word.end, number.start))) return undefined
    next += 1
    word = number
  }
  if (!NUMBER.test(word.text)) return undefined
  let last = next
  for (let more = next + 1; more + 1 < tokens.length; more += 2) {
    const label = tokens[more] as Token
    const value = tokens[more + 1] as Token
    if (!AFTER_NUMBER.test(label.text) || !NUMBER.test(value.text) || !gapOk(tokens[more - 1] as Token, label)) break
    last = more + 1
  }
  return { number: word.text.toLowerCase(), last }
}

// What follows the house number: the flat, the postcode, the city, the region, the country.
const UNIT =
  /^(?:(?:квартира|кв\.?|корпус|корп\.?|к\.|строение|стр\.?|офис|оф\.?|лит\.?|этаж|эт\.?|помещение|помещ\.?|пом\.?|комната|комн\.?|ком\.?|piso|puerta|planta|esc\.?|apt\.?|apartment|suite|ste\.?|unit|flat|floor|pmb)(?<=\.)\s?[\p{L}\d]{1,5}(?![\p{L}\d])|(?:квартира|кв|корпус|корп|строение|стр|офис|оф|лит|этаж|эт|помещение|помещ|пом|комната|комн|ком|piso|puerta|planta|esc|apt|apartment|suite|ste|unit|flat|floor|pmb)(?:\s|(?=\d))[\p{L}\d]{1,5}(?![\p{L}\d])|\d{1,2}(?:st|nd|rd|th) floor|#\d{1,6}(?:-\d{1,4})?|\d{1,2}\s?[ºª°](?:\s?(?:[A-Za-z]|\d{1,2}\s?[ºª]))?(?![\p{L}\d])|\d{1,2}-\d{1,2}(?![\d-])|\d{1,2}[A-Za-z](?![\p{L}\d])|(?:izq(?:da)?|dcha|izquierda|derecha)\.?(?![\p{L}]))/iu
// A US street's direction after its type: «Park Ave S», «Terry Avenue N.».
const DIRECTION = /^(?:N|S|E|W|NE|NW|SE|SW)\.?(?![\p{L}\d])/u
// Title-case words, a district number (Dublin 2), or a country's capitals alone (USA, UK): «NW1» or «CA» belong to
// the postcode that follows.
const PLACE_WORDS =
  /^(?:\(?\p{Lu}\p{Ll}[\p{L}'’-]*\.?(?:(?<!\p{L}{4}\.)[ \t\u00a0]{1,3}(?:de|del|la|le|am|im|upon|on|sur|en|di)?\s?\p{Lu}\p{Ll}[\p{L}'’-]*\.?){0,3}(?: (?:обл\.|область|край|р-н|район))?\)?(?: \d{1,2}(?![\d.,:]\d))?|[A-Z]{2,3}(?![\p{L}\d ]))/u
const CITY_WORD = /^(?:г\.|город|пос\.|посёлок|с\.|обл\.|область)\s?(?=\p{Lu})/iu
// A city written with no comma before it is one only when its postcode or state follows: «Suite 900 San Francisco,
// CA 94103», «PMB 22502 San Francisco, California 94104».
const POSTCODE_AHEAD =
  /^,?[ \t]{1,3}(?:[A-Z]{2}(?: US)?,? \d{5}|\p{Lu}\p{Ll}+ \d{5}|\d{5}|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})/u
const COUNTRY =
  /^(?:USA|US|UK|RU|United[ \t\u00a0]+(?:States|Kingdom)|España|Spain|Germany|Deutschland|France|Italy|Italia|Ireland|Netherlands|Portugal|Poland|Polska|Россия|США|Испания|Германия|Франция|Италия|Великобритания|Canada|Luxembourg|Switzerland|Schweiz|Suisse|Österreich|Austria|Belgium|België|Belgique)(?![\p{L}])/u
// Before the street, in the Russian order: «190000, г. Санкт-Петербург, ул. …», «109316, Регион 77, Москва, …».
const PLACE_PART =
  /(?:Регион \d{1,3}|(?:г\.|город)\s?\p{Lu}[\p{L}-]*(?:[ -]\p{Lu}[\p{L}-]*)?|\p{Lu}\p{Ll}+(?:[ -]\p{Lu}\p{Ll}+)? (?:обл\.|область|край)|\p{Lu}\p{Ll}+(?:-\p{Lu}\p{Ll}+)*)/u
    .source
const BEFORE_STREET = new RegExp(
  `(?:(?:\\d{6}|Россия|РФ),[ ]?|(?:г\\.|город)\\s?\\p{Lu}[\\p{L}-]*,[ ]?)(?:${PLACE_PART},[ ]?)*$`,
  "u",
)
const MOST_TAIL = 100

const isStreetWord = (word: string) =>
  typeOf(BEFORE, word) !== undefined || typeOf(AFTER, word) !== undefined || typeOf(ENGLISH, word) !== undefined

const REGION = /(?:обл\.|область|край|р-н|район)\)?$/u

// The city a place word or a part before the street names, if any: a region, a country or capitals alone are not.
const cityOf = (words: string): string | undefined => {
  const city = words
    .replace(/^(?:г\.|город)\s?/u, "")
    .replace(/[()]/g, "")
    .trim()
  if (!/\p{Ll}/u.test(city) || REGION.test(city) || COUNTRY.test(city) || /^Регион \d/u.test(city)) return undefined
  return city
}

/** How far the address runs past its house number, whether a postcode is in it, and the first city named. */
const tailOf = (text: string, end: number): { end: number; postcode: boolean; city: string | undefined } => {
  let at = end
  let postcode = false
  let city: string | undefined
  let previous: "unit" | "postcode" | "place" | "number" = "number"
  while (at - end < MOST_TAIL) {
    const gap = /^(?:[ \t]*\r?\n(?:[ \t]*\r?\n)?[ \t]*|, ?| ?\| ?| [–-] |[ \t\u00a0]{1,3})/.exec(text.slice(at))?.[0]
    if (!gap) break
    const rest = text.slice(at + gap.length)
    const newLine = gap.includes("\n")
    const comma = /[,|–-]/.test(gap)
    const code = POSTCODES.map((one) => one.exec(rest)?.[0]).find((one) => one !== undefined)
    const unit = UNIT.exec(rest)?.[0] ?? (previous === "number" ? DIRECTION.exec(rest)?.[0] : undefined)
    const country = COUNTRY.exec(rest)?.[0]
    const cityWord = CITY_WORD.exec(rest)?.[0] ?? ""
    // A full stop after a word of four letters or more ends the sentence; after a shorter one it is «обл.».
    const words = PLACE_WORDS.exec(rest.slice(cityWord.length))?.[0]?.replace(/(\p{L}{4,})\.$/u, "$1")
    const ahead = words !== undefined && POSTCODE_AHEAD.test(rest.slice(cityWord.length + words.length))
    // A city follows a comma, a postcode, or comes before its postcode: «Calle Mayor 12 Мы ждём» has no city. On
    // the next line only a flat, a postcode, a city with its postcode or a country continue the address.
    const follows = newLine
      ? ahead
      : comma || previous === "postcode" || ahead || (previous === "place" && rest.startsWith("("))
    const place = follows && words && !isStreetWord(words.split(" ")[0] ?? "") ? words : undefined
    if (code) {
      postcode = true
      previous = "postcode"
      at += gap.length + code.length
    } else if (unit && previous !== "place") {
      previous = "unit"
      at += gap.length + unit.length
    } else if (country && (comma || newLine || previous === "postcode" || previous === "place")) {
      previous = "place"
      at += gap.length + country.length
    } else if (place) {
      previous = "place"
      city ??= cityOf(place)
      at += gap.length + cityWord.length + place.length
    } else break
  }
  return { end: at, postcode, city }
}

// «190000, г. Санкт-Петербург, » before the street: the last part that is a city.
const headCity = (head: string): string | undefined =>
  head
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && !/^\d+$/.test(part) && !/^(?:Россия|РФ)$/u.test(part))
    .map(cityOf)
    .filter((part) => part !== undefined)
    .at(-1)

const folded = (words: string[]) =>
  words
    .join(" ")
    .toLowerCase()
    .replace(/[,]|\.(?=\s|$)/g, "")
    .replace(/\s+/g, " ")
    .trim()

/**
 * Addresses by their grammar, never a number alone: a street word (ул., calle, rue, via, Straße, Street) next to a
 * name and a house number. The span runs on over the flat, postcode, city and country on the same line; the value
 * is the street and the house, then `, <city>` when a city is written, so one street in two cities is two values and
 * a flat or a postcode does not split one address. A postcode raises the confidence. Unknown places start undecided.
 */
export const findPlaces = (text: string): FoundPlace[] => {
  const tokens = tokensOf(text)
  const found: FoundPlace[] = []
  const add = (first: number, last: number, words: string[]) => {
    const street = (tokens[first] as Token).start
    if (found.some((one) => street < one.end && (tokens[last] as Token).end > one.start)) return
    const tail = tailOf(text, (tokens[last] as Token).end)
    const head = BEFORE_STREET.exec(text.slice(Math.max(0, street - 120), street))?.[0] ?? ""
    const postcode = tail.postcode || /\d{6}/.test(head)
    const city = tail.city ?? headCity(head)
    found.push({
      start: street - head.length,
      end: tail.end,
      value: city === undefined ? folded(words) : `${folded(words)}, ${folded([city])}`,
      confidence: postcode ? 0.7 : 0.5,
    })
  }
  // Each reading returns whether it found an address; «проспект» and «Avenue» may stand before or after the name.
  const before = (at: number): boolean => {
    const type = typeOf(BEFORE, (tokens[at] as Token).text)
    if (type === undefined) return false
    const name = nameRun(tokens, at + 1, text, 1)
    if (name.length === 0) return false
    const words = name.map((one) => (tokens[one] as Token).text)
    const leading = tokens[at - 1]
    // French and Spanish may put the number first: 12 rue de la Paix.
    if (leading && NUMBER.test(leading.text) && /^,? $/.test(text.slice(leading.end, (tokens[at] as Token).start))) {
      add(at - 1, name.at(-1) as number, [type, ...words, leading.text])
      return true
    }
    const number = numberAfter(tokens, name.at(-1) as number, text)
    if (number) add(at, number.last, [type, ...words, number.number])
    return number !== undefined
  }
  const after = (at: number): boolean => {
    const token = tokens[at] as Token
    const type = typeOf(AFTER, token.text)
    if (type === undefined && !FUSED.test(token.text)) return false
    // A Russian street named before its word is one adjective: Невский проспект, not «На Невский проспект».
    const most = /\p{Script=Cyrillic}/u.test(token.text) ? 1 : 5
    const name = type === undefined ? [] : nameRun(tokens, at - 1, text, -1, most)
    if (type !== undefined && name.length === 0) return false
    const number = numberAfter(tokens, at, text)
    if (!number) return false
    add(name[0] ?? at, number.last, [
      ...name.map((one) => (tokens[one] as Token).text),
      type ?? token.text,
      number.number,
    ])
    return true
  }
  const english = (at: number): boolean => {
    const type = typeOf(ENGLISH, (tokens[at] as Token).text)
    const name = type === undefined ? [] : nameRun(tokens, at - 1, text, -1)
    const first = name[0]
    const leading = first === undefined ? undefined : tokens[first - 1]
    if (first === undefined || !leading || !NUMBER.test(leading.text)) return false
    if (text.slice(leading.end, (tokens[first] as Token).start) !== " ") return false
    add(first - 1, at, [leading.text, ...name.map((one) => (tokens[one] as Token).text), type as string])
    return true
  }
  for (let at = 0; at < tokens.length; at++) before(at) || after(at) || english(at)
  return found.sort((a, b) => a.start - b.start)
}
