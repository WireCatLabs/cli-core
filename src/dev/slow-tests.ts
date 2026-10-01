/** The slowest tests and files from vitest's JSON report (`--reporter=json`), slowest first. */
export interface VitestReport {
  testResults: {
    name: string
    startTime: number
    endTime: number
    assertionResults: { title: string; duration?: number }[]
  }[]
}

export const slowTests = (report: VitestReport, cwd: string, count: number): string => {
  const relative = (path: string) => path.slice(cwd.length + 1)
  const tests = report.testResults
    .flatMap((result) =>
      result.assertionResults.map((test) => ({ ms: test.duration ?? 0, file: result.name, test: test.title })),
    )
    .sort((a, b) => b.ms - a.ms)
  const files = report.testResults
    .map((result) => ({ ms: result.endTime - result.startTime, file: result.name }))
    .sort((a, b) => b.ms - a.ms)

  const total = tests.reduce((sum, test) => sum + test.ms, 0)
  return [
    `${tests.length} tests, ${(total / 1000).toFixed(1)} s of test time\n\nslowest tests:`,
    ...tests.slice(0, count).map(({ ms, file, test }) => `${ms.toFixed(0).padStart(6)} ms  ${relative(file)}  ${test}`),
    "\nslowest files:",
    ...files.slice(0, 10).map(({ ms, file }) => `${ms.toFixed(0).padStart(6)} ms  ${relative(file)}`),
  ].join("\n")
}
