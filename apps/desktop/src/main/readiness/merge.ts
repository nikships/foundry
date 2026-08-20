/**
 * Merge confirmation for a readiness PR. The flow both polls while open and
 * verifies an "I have merged" click, so a premature confirm stays waiting.
 */

export interface PrMergeView {
  number: number;
  url: string;
  merged: boolean;
  state: string;
}

export interface MergeCheck {
  merged: boolean;
  detail: string;
  pr: PrMergeView | null;
}

export function mergeCheckFromView(view: PrMergeView | null): MergeCheck {
  if (!view) {
    return {
      merged: false,
      detail: 'Could not confirm the pull request. It may still be open, or gh could not see it.',
      pr: null,
    };
  }
  if (view.merged || view.state.toUpperCase() === 'MERGED') {
    return {
      merged: true,
      detail: `PR #${view.number} is merged.`,
      pr: { ...view, merged: true },
    };
  }
  return {
    merged: false,
    detail: `PR #${view.number} is still ${view.state || 'open'}. Merge it on GitHub, then confirm again.`,
    pr: { ...view, merged: false },
  };
}

export async function pollPrMerged(input: {
  view: () => Promise<PrMergeView | null>;
  isCancelled?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
  onTick?: (check: MergeCheck) => void;
}): Promise<MergeCheck> {
  const intervalMs = input.intervalMs ?? 5_000;
  const timeoutMs = input.timeoutMs ?? 30 * 60_000;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = Date.now();
  let last = mergeCheckFromView(null);

  while (!input.isCancelled?.()) {
    last = mergeCheckFromView(await input.view());
    input.onTick?.(last);
    if (last.merged) return last;
    if (intervalMs <= 0) return last;
    if (Date.now() - started >= timeoutMs) {
      return {
        merged: false,
        detail: `${last.detail} Still waiting after ${Math.round(timeoutMs / 1000)}s.`,
        pr: last.pr,
      };
    }
    await sleep(intervalMs);
  }

  return { merged: false, detail: 'Merge polling stopped.', pr: last.pr };
}
