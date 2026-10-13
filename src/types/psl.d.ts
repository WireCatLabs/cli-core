// psl 1.15 ships types, but its package.json "exports" hides them from NodeNext resolution.
declare module "psl" {
  interface Parsed {
    domain: string | null
    listed: boolean
  }
  const psl: {
    get(domain: string): string | null
    parse(input: string): Parsed | { error: { code: string; message: string } }
  }
  export default psl
}
