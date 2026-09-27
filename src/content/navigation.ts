// Pure logic for the pill's ▲/▼ "jump to flagged sentence" navigation and
// the "2/5" counter. Kept free of the DOM so it is unit-testable
// (see navigation.test.ts).

export interface FlaggedKey {
  blockId: string;
  index: number;
}

/**
 * Sorts flagged sentence keys into stable document order: block order first
 * (as given, since blocks are already collected in document order by
 * extract.ts), then sentence index within the block.
 */
export function orderFlagged(keys: FlaggedKey[], blockOrder: string[]): FlaggedKey[] {
  const rank = new Map(blockOrder.map((id, i) => [id, i]));
  return [...keys].sort((a, b) => {
    const ra = rank.get(a.blockId) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b.blockId) ?? Number.MAX_SAFE_INTEGER;
    return ra !== rb ? ra - rb : a.index - b.index;
  });
}

/**
 * Steps the current index by `direction` (1 = next/▼, -1 = prev/▲),
 * wrapping around. Returns -1 when there is nothing to navigate to.
 */
export function stepIndex(current: number, length: number, direction: 1 | -1): number {
  if (length <= 0) return -1;
  if (current < 0 || current >= length) return direction === 1 ? 0 : length - 1;
  return (current + direction + length) % length;
}

/** "2/5", or "0/0" when nothing is flagged. */
export function formatCounter(current: number, total: number): string {
  if (total <= 0) return "0/0";
  const clamped = Math.max(0, Math.min(total - 1, current));
  return `${clamped + 1}/${total}`;
}
