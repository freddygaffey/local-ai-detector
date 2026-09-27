// Pure formatting helpers shared by the popup and options pages. Kept free
// of DOM/browser APIs so they're trivially unit-testable.

/** "34 MB" / "1.2 GB" — one decimal place, dropped when it would be ".0". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 MB";
  if (bytes === 0) return "0 MB";
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const rounded = unitIndex === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

/** Same, but for a plain megabyte count (used by the static size registry). */
export function formatMB(mb: number): string {
  return formatBytes(mb * 1024 * 1024);
}

/** 0..1 -> "42%". Clamped and rounded to the nearest whole percent. */
export function formatPercent(score: number): string {
  const pct = Math.round(clamp01(score) * 100);
  return `${pct}%`;
}

/** 0..1 -> 42 (whole percent, no "%"), for compact spots like the badge. */
export function toPercentInt(score: number): number {
  return Math.round(clamp01(score) * 100);
}

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** A commit SHA (or "main"/"latest") shortened to a stable display length. */
export function shortSha(revision: string, length = 7): string {
  if (!revision) return "—";
  if (!/^[0-9a-f]{8,40}$/i.test(revision)) return revision; // branch names etc., shown as-is
  return revision.slice(0, length);
}

/** "1 sentence" / "3 sentences" */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** "3 min ago" / "just now" / "2 days ago", for "last checked" timestamps. */
export function relativeTime(fromMs: number, nowMs: number = Date.now()): string {
  const deltaSec = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (deltaSec < 30) return "just now";
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const minutes = Math.round(deltaSec / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
