import {
  type RecordingSyncCheckpoint,
  type RecordingSyncCheckpointStore,
  RecordingSyncError,
  type RecordingSyncLease,
} from "../recording-sync.js"

export function memoryRecordingSyncCheckpointStore(): RecordingSyncCheckpointStore {
  const checkpoints = new Map<string, RecordingSyncCheckpoint>()
  const leases = new Map<string, string>()
  let sequence = 0
  const own = (jobId: string, token: string): void => {
    if (leases.get(jobId) !== token) throw new RecordingSyncError("conflict", "archive checkpoint lease is not owned")
  }
  return {
    async acquire(jobId): Promise<RecordingSyncLease> {
      if (leases.has(jobId)) throw new RecordingSyncError("conflict", "archive job is already active")
      const token = String(++sequence)
      leases.set(jobId, token)
      return {
        token,
        async release() {
          own(jobId, token)
          leases.delete(jobId)
        },
      }
    },
    async read(jobId, token) {
      own(jobId, token)
      return structuredClone(checkpoints.get(jobId) ?? null)
    },
    async save(jobId, token, expectedRevision, state) {
      own(jobId, token)
      if (
        (checkpoints.get(jobId)?.revision ?? null) !== expectedRevision ||
        state.revision !== (expectedRevision ?? 0) + 1
      )
        throw new RecordingSyncError("conflict", "archive checkpoint revision changed")
      checkpoints.set(jobId, structuredClone(state))
    },
  }
}
