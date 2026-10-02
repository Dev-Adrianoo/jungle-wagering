// Polls a condition instead of sleeping a fixed time: the test continues as soon as the
// condition holds and fails with a clear message when it never does.
export async function waitFor<T>(
  probe: () => Promise<T | undefined | false>,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    description?: string | (() => string);
  } = {},
): Promise<T> {
  const { timeoutMs = 15_000, intervalMs = 100, description = 'condition' } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() >= deadline) {
      const waitedFor = typeof description === 'function' ? description() : description;
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${waitedFor}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
