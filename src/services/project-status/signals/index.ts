import type { StatusSignal } from "../types.js"
import { amounts } from "./amounts.js"
import { children } from "./children.js"
import { coverage } from "./coverage.js"
import { lastMessage } from "./last-message.js"
import { payments } from "./payments.js"
import { promises } from "./promises.js"
import { questions } from "./questions.js"
import { replyNext } from "./reply-next.js"
import { topics } from "./topics.js"

/** The registry; its order is the answer's order. A new signal is one file here and its row in the CLI. */
export const STATUS_SIGNALS: readonly StatusSignal[] = [
  lastMessage,
  replyNext,
  questions,
  promises,
  amounts,
  payments,
  topics,
  coverage,
  children,
] as readonly StatusSignal[]
