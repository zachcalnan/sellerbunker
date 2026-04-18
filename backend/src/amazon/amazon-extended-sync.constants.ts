/**
 * Private deep order history (365d + ignoreCursor) is only enabled for this login email.
 * Not configurable via env — keeps other accounts/orgs on the normal 30-day cap.
 */
export const AMAZON_EXTENDED_ORDER_HISTORY_EMAIL =
  'rugby.4.lif3@hotmail.com'.toLowerCase();

/** Bump with `AmazonExtendedHistoryBootstrap` when a full-year re-pull should run again. */
export const AMAZON_EXTENDED_ORDER_HISTORY_DONE_KEY_PREFIX =
  'sb:extended-order-history-done:v6:';
export const AMAZON_EXTENDED_ORDER_HISTORY_LOCK_KEY_PREFIX =
  'sb:extended-order-history-lock:v6:';
