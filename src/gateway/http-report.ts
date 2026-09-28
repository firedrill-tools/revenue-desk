// What an API tool's HTTP exchanges tell the action log (docs/ARCHITECTURE.md
// §5, §8): the status of the provider's last response, and the idempotency
// key a write actually sent.
//
// The gateway runs each API tool call in a report scope (reportingHttp); the
// integrations' HTTP layer (src/integrations/shared/http.ts) notes every
// request it sends and every response it gets into the current scope.
// Outside a scope (probes, tests of a client) the notes go nowhere. The scope
// follows the call's async work, so concurrent calls never mix their reports.

import { AsyncLocalStorage } from "node:async_hooks";

export type HttpReport = {
  /** The last response's HTTP status (2xx included); null when none arrived. */
  readonly httpStatus: number | null;
  /** The idempotency key of a request that was sent; null when no request carried one. */
  readonly idempotencyKey: string | null;
};

type MutableReport = { httpStatus: number | null; idempotencyKey: string | null };

const scope = new AsyncLocalStorage<MutableReport>();

/** Runs `call` in a fresh report scope and returns what its HTTP exchanges reported. */
export async function reportingHttp<T>(
  call: () => Promise<T>,
): Promise<
  | { readonly ok: true; readonly value: T; readonly report: HttpReport }
  | { readonly ok: false; readonly error: unknown; readonly report: HttpReport }
> {
  const report: MutableReport = { httpStatus: null, idempotencyKey: null };
  try {
    const value = await scope.run(report, call);
    return { ok: true, value, report: { ...report } };
  } catch (error) {
    return { ok: false, error, report: { ...report } };
  }
}

/** A request is about to be sent; `idempotencyKey` is the key it carries, if any. */
export function noteHttpRequest(idempotencyKey: string | null | undefined): void {
  const report = scope.getStore();
  if (report === undefined || idempotencyKey === null || idempotencyKey === undefined) return;
  report.idempotencyKey = idempotencyKey;
}

/** A response arrived with this status. */
export function noteHttpResponse(status: number): void {
  const report = scope.getStore();
  if (report !== undefined) report.httpStatus = status;
}
