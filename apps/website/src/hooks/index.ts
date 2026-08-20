import { useEffect, useRef, useState } from 'react';

/** True when the user has asked for reduced motion. Demos render their
 *  finished state instead of animating to it. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * Observes an element and reports whether it is on screen. Animations and
 * video playback hang off this so nothing burns CPU below the fold.
 */
export function useInView<T extends HTMLElement>(
  threshold = 0.2,
  once = false,
): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (!('IntersectionObserver' in window)) {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setInView(entry.isIntersecting);
          if (entry.isIntersecting && once) io.unobserve(entry.target);
        }
      },
      { threshold, rootMargin: '0px 0px -4% 0px' },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [threshold, once]);

  return [ref, inView];
}

/**
 * A requestAnimationFrame loop that only runs while `active` is true and
 * reports elapsed milliseconds since it (re)started. The callback is kept in a
 * ref so a changing closure never restarts the loop.
 */
export function useRafElapsed(active: boolean, onFrame: (elapsedMs: number) => void): void {
  const cb = useRef(onFrame);
  cb.current = onFrame;

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let start = 0;
    const tick = (now: number) => {
      if (!start) start = now;
      cb.current(now - start);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
}

/** Adds a hairline to the sticky nav once the page has scrolled at all. */
export function useScrolled(px = 12): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > px);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [px]);
  return scrolled;
}
