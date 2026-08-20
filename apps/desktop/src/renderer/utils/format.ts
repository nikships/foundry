/**
 * Formatting used across screens. Kept in one place so a duration in the
 * waterfall reads the same as a duration in the run list.
 */

export function duration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest.toString().padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${(minutes % 60).toString().padStart(2, '0')}m`;
}

export function since(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function clockTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function tokens(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Duration as MM:SS for compact badges (e.g. 02:05, 14:32, 00:08). */
export function durationClock(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

/** Tokens as XXXK / X.XM for compact badges (e.g. 53K, 1.2M). */
export function tokensBadge(n: number | null | undefined): string {
  if (n == null || n === 0) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const STATUS_COLORS: Record<string, string> = {
  queued: 'var(--status-queued)',
  running: 'var(--status-running)',
  success: 'var(--status-success)',
  fail: 'var(--status-fail)',
  skipped: 'var(--status-skipped)',
  accepted: 'var(--status-accepted)',
  rejected: 'var(--status-rejected)',
  failed: 'var(--status-failed)',
  killed: 'var(--status-killed)',
};

export function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? 'var(--text-faint)';
}

const STATUS_WORDS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  success: 'Passed',
  fail: 'Failed',
  skipped: 'Skipped',
  accepted: 'Accepted',
  rejected: 'Not accepted',
  failed: 'Failed',
  killed: 'Killed',
};

export function statusWord(status: string): string {
  return STATUS_WORDS[status] ?? status;
}
