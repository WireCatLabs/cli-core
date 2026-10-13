/** Replaces the body between `<!-- name: generated -->` and `<!-- name: end -->` for each block. */
export const withGenerated = (text: string, blocks: [name: string, body: string][]): string => {
  let result = text
  for (const [name, body] of blocks) {
    const start = `<!-- ${name}: generated -->`
    const end = `<!-- ${name}: end -->`
    if (!result.includes(start) || !result.includes(end)) throw new Error(`missing ${name} generation markers`)
    const from = result.indexOf(start) + start.length
    const to = result.indexOf(end, from)
    result = `${result.slice(0, from)}\n\n${body}\n\n${result.slice(to)}`
  }
  return result
}

export const cell = (value: string) => value.replaceAll("|", "\\|")
