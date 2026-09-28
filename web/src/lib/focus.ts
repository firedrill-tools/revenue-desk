/**
 * For Radix Dialog/Sheet `onOpenAutoFocus`: focus the panel itself instead of
 * its first control (the close button), so opening with the mouse does not
 * paint a focus ring; Tab still moves into the panel.
 */
export function focusPanelOnOpen(event: Event): void {
  event.preventDefault();
  const panel = event.target;
  if (panel instanceof HTMLElement) panel.focus({ preventScroll: true });
}
