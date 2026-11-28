/**
 * Bundles the parts of ECharts the chart renderer uses into `dist/charts/echarts.js`, over what `tsc` wrote.
 * Installed from npm, `echarts` and `zrender` take 67 MB, nearly all of it prebuilt bundles nothing loads; the
 * bar and line charts with the SVG renderer bundle to about 570 KB. Their notices are in THIRD_PARTY_NOTICES.
 *
 *   node scripts/bundle-echarts.ts          (part of `pnpm build`)
 */
import { join } from "node:path"
import { build } from "esbuild"

const root = join(import.meta.dirname, "..")
await build({
  entryPoints: [join(root, "src/charts/echarts.ts")],
  outfile: join(root, "dist/charts/echarts.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  minify: true,
  logLevel: "warning",
})
