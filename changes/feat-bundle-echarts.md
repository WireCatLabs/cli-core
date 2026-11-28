### Fixed

- **A fresh install is about 65 MB smaller: charts ship the parts of ECharts they use, bundled.** `echarts`, `zrender`
  and `tslib` are no longer dependencies; `dist/charts/echarts.js` (570 KB) holds what the bar and line charts and
  the SVG renderer need. Charts render the same SVG and PNG as before, offline. An app that imported `echarts`
  itself, counting on cli-core to install it, now lists it in its own dependencies; no WireCat CLI does. The licence
  notices of the bundled code are in `THIRD_PARTY_NOTICES` ([architecture](../docs/dev/ARCHITECTURE.md)).
