import type { EChartsCoreOption } from "echarts/core"
import type { ChartData } from "./model.js"

export const echartsOption = (chart: ChartData) =>
  ({
    animation: false,
    backgroundColor: "#111827",
    color: chart.kind === "grouped-bar" ? ["#34d399", "#fb923c"] : ["#818cf8"],
    textStyle: { color: "#e5e7eb", fontFamily: "Arial, sans-serif" },
    title: {
      text: chart.title,
      subtext: [chart.timezone, ...(chart.partial ? ["Partial data — lower bounds"] : [])].join(" · "),
      left: 24,
      top: 16,
      textStyle: { color: "#f9fafb", fontSize: 20, fontWeight: 600 },
      subtextStyle: { color: chart.partial ? "#fbbf24" : "#9ca3af", fontSize: 12 },
    },
    grid: { left: 72, right: 28, top: 108, bottom: 60 },
    legend: { show: chart.series.length > 1, top: 76, textStyle: { color: "#e5e7eb" } },
    xAxis: {
      type: "category",
      data: chart.x.values,
      axisLabel: { color: "#9ca3af", hideOverlap: true },
      axisLine: { lineStyle: { color: "#374151" } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      name: chart.unit,
      min: 0,
      minInterval: 1,
      nameTextStyle: { color: "#9ca3af" },
      axisLabel: { color: "#9ca3af" },
      splitLine: { lineStyle: { color: "#263244" } },
    },
    series: chart.series.map(({ name, values }) => ({
      name,
      type: chart.kind === "line" ? "line" : "bar",
      data: values,
      ...(chart.kind === "line"
        ? { connectNulls: false, showSymbol: true, symbolSize: 6, lineStyle: { width: 3 } }
        : { barMaxWidth: 36, itemStyle: { borderRadius: [4, 4, 0, 0] } }),
    })),
    ...(chart.x.values.length === 0
      ? {
          graphic: {
            type: "text",
            left: "center",
            top: "middle",
            style: { text: "No data", fill: "#9ca3af", fontSize: 16 },
          },
        }
      : {}),
  }) satisfies EChartsCoreOption
