/**
 * Animate elements to their new positions after an edit moves them.
 *
 * A reorder rewrites an array, so React repaints every affected element at its
 * new coordinates in one frame and the whole board appears to snap. This runs
 * the standard invert-then-play trick over any descendant carrying
 * `data-settle`: the position from the previous commit is inverted with a
 * transform, then released, so an element that jumped reads as having travelled.
 *
 * Positions are re-read on scroll because scrolling moves an element without
 * re-rendering it, and a stale reading would animate the next edit from a
 * position the element never held.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const SETTLE_MS = 260;
/** Overshoots slightly, so an element lands with weight instead of easing flat. */
const SETTLE_EASING = 'cubic-bezier(0.22, 1.28, 0.3, 1)';
/** Sub-pixel drift is layout noise, not movement worth animating. */
const MIN_TRAVEL_PX = 1;

type Point = { x: number; y: number };

function snapshot(root: HTMLElement, into: Map<string, Point>): void {
  const seen = new Set<string>();
  for (const node of root.querySelectorAll<HTMLElement>('[data-settle]')) {
    const id = node.dataset.settle;
    if (!id) continue;
    seen.add(id);
    const box = node.getBoundingClientRect();
    into.set(id, { x: box.left, y: box.top });
  }
  for (const id of [...into.keys()]) if (!seen.has(id)) into.delete(id);
}

export function useSettleLayout(
  root: RefObject<HTMLElement | null>,
  /** Changes whenever the elements are laid out somewhere new. */
  layout: string,
  /** The element the caller animates itself, usually whatever is being dragged. */
  exempt: string | null,
): void {
  const previous = useRef(new Map<string, Point>());

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const before = previous.current;
    const after = new Map<string, Point>();
    snapshot(el, after);

    for (const [id, next] of after) {
      const prev = before.get(id);
      if (!prev || id === exempt) continue;
      const dx = prev.x - next.x;
      const dy = prev.y - next.y;
      if (Math.abs(dx) < MIN_TRAVEL_PX && Math.abs(dy) < MIN_TRAVEL_PX) continue;
      const node = el.querySelector<HTMLElement>(`[data-settle="${CSS.escape(id)}"]`);
      if (!node || typeof node.animate !== 'function') continue;
      node.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0px, 0px)' }],
        { duration: SETTLE_MS, easing: SETTLE_EASING },
      );
    }

    previous.current = after;
  }, [layout, root, exempt]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const remeasure = (): void => snapshot(el, previous.current);
    el.addEventListener('scroll', remeasure, { capture: true, passive: true });
    return () => el.removeEventListener('scroll', remeasure, { capture: true });
  }, [root]);
}
