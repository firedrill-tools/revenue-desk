// Errors the CLI's services report so `ask` can answer with the right exit code.

/**
 * The conversation already has an active run (in the app or another CLI):
 * a usage error (exit 2), as the README says, not a failed run.
 */
export class ActiveRunError extends Error {
  override readonly name = "ActiveRunError";
  readonly code = "run_active";
}

/** An ActiveRunError, also one from another copy of this module (tests' fakes). */
export function isActiveRunError(error: unknown): error is ActiveRunError {
  return (
    error instanceof Error &&
    (error as Partial<ActiveRunError>).code === "run_active" &&
    error.name === "ActiveRunError"
  );
}

/** SQLite refusing a second running run of a conversation (runs_one_running_per_conversation). */
export function isRunningRunConflict(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed: runs\.conversation_id/.test(error.message)
  );
}
