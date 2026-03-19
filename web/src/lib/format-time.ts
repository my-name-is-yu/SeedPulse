/** Format an ISO timestamp as relative time (e.g., "3m ago"). */
export function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '--';

  const diffMs = now - then;
  if (diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Format elapsed time from ISO start to now (e.g., "1m 23s"). */
export function elapsedTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '--';

  const diffMs = Math.max(0, now - then);
  const seconds = Math.floor(diffMs / 1000) % 60;
  const minutes = Math.floor(diffMs / 60000) % 60;
  const hours = Math.floor(diffMs / 3600000);

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
