// Bun hangs when `expect(promise).rejects` is handed a driver query that is still pending, so
// the promise is awaited here and the assertion runs on the thrown error.
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject, but it resolved');
}
