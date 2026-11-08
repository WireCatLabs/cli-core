import { Liquid, Tag, type TagToken, type TopLevelToken } from "liquidjs"

export interface LiquidLimits {
  /** Characters of template source. */
  parse: number
  /** Bytes a render may allocate, as LiquidJS counts them. */
  memory: number
  milliseconds: number
}

/**
 * The one Liquid engine for owner-written templates (reply rules, report templates): unknown variables and filters
 * are errors, only own properties are read, and `include`, `render` and `layout` are refused, so a template cannot
 * read a file.
 */
export const safeLiquid = (limits: LiquidLimits): Liquid => {
  const engine = new Liquid({
    ownPropertyOnly: true,
    strictVariables: true,
    strictFilters: true,
    lenientIf: false,
    parseLimit: limits.parse,
    renderLimit: limits.milliseconds,
    memoryLimit: limits.memory,
    preserveTimezones: true,
  })
  for (const name of ["include", "render", "layout"]) {
    engine.registerTag(
      name,
      class extends Tag {
        constructor(token: TagToken, tokens: TopLevelToken[], liquid: Liquid) {
          super(token, tokens, liquid)
          throw new Error("templates cannot read files")
        }
        render() {
          return ""
        }
      },
    )
  }
  return engine
}
