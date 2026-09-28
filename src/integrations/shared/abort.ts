// Racing work that takes no AbortSignal (SDK calls, child processes) against one.

/**
 * Settles with `promise`, or rejects with the signal's reason as soon as it
 * aborts. A value that arrives after the abort is handed to `discard` so the
 * caller can release it (close a connection, kill a child).
 */
export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  discard: (lateValue: T) => void = () => {},
): Promise<T> {
  if (signal.aborted) {
    promise.then(discard, () => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      promise.then(discard, () => {});
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}
