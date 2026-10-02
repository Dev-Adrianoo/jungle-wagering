// A log line or a metric is never worth a failed or masked transaction: whatever a logger or
// a metric throws stays here, so the result and the original error reach the caller intact.
export function safely(observe: () => void): void {
  try {
    observe();
  } catch {}
}
