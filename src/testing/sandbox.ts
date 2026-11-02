// Every `openStore` loads Drizzle, about 200 ms from `node_modules`: loaded here, it is not charged to a test's timeout.
import "../store/sqlite/drizzle/node.js"
import { isMainThread } from "node:worker_threads"

// A worker thread's own HOME does not move `os.homedir()`, so a test that passes an env without HOME writes to the
// owner's real folders: `vitest --pool=threads` put test rows into the real store on 2026-10-18.
if (!isMainThread) throw new Error("cli-core's tests run only in vitest's forks pool; drop --pool=threads/vmThreads")

// cli-base's setup, listed before this file, owns the folders, the keyring and the network; this is what cli-core adds.
for (const prefix of ["APP", "CHAT", "TG", "MAX"]) {
  // Every test shares one profile's pace file: paced, a file of tests would wait on each other's calls.
  process.env[`${prefix}_REQUESTS_PER_MINUTE`] = "0"
  // No profile is ever assumed; a test that means "no profile named" passes its own env without this.
  process.env[`${prefix}_PROFILE`] = "default"
}
// Set in an agent's own shell, where it would make every run print the skill hint and read the real ~/.claude.
delete process.env.AI_AGENT
delete process.env.CLAUDECODE
for (const key of Object.keys(process.env)) {
  if (/^(APP|CHAT|TG|MAX)_(MODELS|EMBEDDING|ANALYSIS)_/.test(key)) delete process.env[key]
}
