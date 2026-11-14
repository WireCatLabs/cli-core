const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  shy: "\u00ad",
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
  zwnj: "\u200c",
  zwj: "\u200d",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  lsaquo: "‹",
  rsaquo: "›",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  sect: "§",
  para: "¶",
  iexcl: "¡",
  iquest: "¿",
}

const character = (code: number, entity: string): string =>
  code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity

/**
 * HTML character references as text, in one pass so `&amp;lt;` stays the text `&lt;`. Numeric ones are all decoded;
 * of the named ones, those that mail and calendar invitations use. An unknown name stays as written.
 */
export const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (entity, body: string) => {
    if (body[0] !== "#") return NAMED[body] ?? NAMED[body.toLowerCase()] ?? entity
    return body[1] === "x" || body[1] === "X"
      ? character(Number.parseInt(body.slice(2), 16), entity)
      : character(Number(body.slice(1)), entity)
  })
