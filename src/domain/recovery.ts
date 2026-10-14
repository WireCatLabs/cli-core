export interface ActionableError {
  code: string
  message: string
  retryable: boolean
  retry_after_ms?: number
  [key: string]: unknown
}
