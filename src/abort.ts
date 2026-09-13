export const abortedResult = Symbol("aborted");

export function abortPromise(
  signal?: AbortSignal,
): { promise: Promise<typeof abortedResult>; dispose(): void } | undefined {
  if (!signal) {
    return undefined;
  }
  if (signal.aborted) {
    return { promise: Promise.resolve(abortedResult), dispose: () => undefined };
  }
  let resolveAbort!: (value: typeof abortedResult) => void;
  const promise = new Promise<typeof abortedResult>((resolve) => {
    resolveAbort = resolve;
  });
  const abort = () => resolveAbort(abortedResult);
  signal.addEventListener("abort", abort, { once: true });
  return { promise, dispose: () => signal.removeEventListener("abort", abort) };
}
