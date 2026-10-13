export interface RecoveryAction {
  type: "wait" | "retry" | "configure" | "skip" | "check"
  message: string
  afterMs?: number
  setting?: string
}

export interface ActionableError {
  code: string
  message: string
  retryable: boolean
  actions: RecoveryAction[]
  retry_after_ms?: number
  [key: string]: unknown
}
