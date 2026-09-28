/**
 * The chat's one column: the thread, the empty state and the composer share
 * it, so their edges line up (760px including the 16/24px gutters).
 */
export const CHAT_COLUMN = "mx-auto w-full max-w-[760px] px-4 sm:px-6";

/** The composer's dock below the thread: safe-area aware at the bottom. */
export const COMPOSER_DOCK = "shrink-0 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]";
