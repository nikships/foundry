import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import type { AgentDef } from '@shared/types.js';
import { useTablistNav } from '../../hooks/useTablistNav.js';
import { rosterScrollEdges } from '../../view-models/roster-scroll.js';
import AgentAvatar from '../media/AgentAvatar.js';
import ProviderBubble from '../media/ProviderBubble.js';
import { cx } from '../ui/cx.js';
import styles from './MedallionDock.module.css';

/** The selection bar's glide — the only motion the dock runs. */
const BAR_SPRING = { type: 'spring', stiffness: 500, damping: 42, mass: 0.6 } as const;

/**
 * Every agent as an identical medallion along the bottom edge: portrait plus
 * a bubble for the backing model's mark, nothing else. Selection never
 * reshapes the rail — the active medallion brightens, lifts, and glows in its
 * hue while a small bar glides under it. Only transforms and opacity animate,
 * so the dock stays glassy no matter where the click lands.
 */
export default function MedallionDock({
  agents,
  selectedName,
  onSelect,
  onCreate,
  providerForAgent,
}: {
  agents: AgentDef[];
  selectedName: string;
  onSelect: (name: string) => void;
  onCreate: () => void;
  /** Vendor behind the model an agent would run with ('' when unknown). */
  providerForAgent: (agent: AgentDef) => string;
}): React.JSX.Element {
  const railRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const [edges, setEdges] = useState({ before: false, after: false });
  const onTablistKey = useTablistNav();
  const reduce = useReducedMotion();

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const updateEdges = (): void => setEdges(rosterScrollEdges(rail));
    updateEdges();
    const observer = new ResizeObserver(updateEdges);
    observer.observe(rail);
    if (rail.firstElementChild) observer.observe(rail.firstElementChild);
    return () => observer.disconnect();
  }, [agents.length]);

  // Center the selected medallion, but only when it is actually clipped —
  // an unneeded smooth scroll would drag the rail out from under the gliding
  // selection bar. When a scroll is needed, let the bar land first.
  const centeredOnceRef = useRef(false);
  useEffect(() => {
    const el = itemRefs.current.get(selectedName);
    const rail = railRef.current;
    if (!el || !rail) return;
    const item = el.getBoundingClientRect();
    const railBox = rail.getBoundingClientRect();
    const clipped = item.left < railBox.left + 1 || item.right > railBox.right - 1;
    const instant = !centeredOnceRef.current || reduce;
    if (!clipped && centeredOnceRef.current) return;
    const timer = setTimeout(
      () => {
        el.scrollIntoView({
          behavior: instant ? 'auto' : 'smooth',
          inline: 'center',
          block: 'nearest',
        });
        centeredOnceRef.current = true;
      },
      instant ? 0 : 240,
    );
    return () => clearTimeout(timer);
  }, [selectedName, reduce]);

  const scrollRail = (direction: -1 | 1): void => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({ left: direction * Math.max(340, rail.clientWidth * 0.75), behavior: 'smooth' });
  };

  return (
    <div className={styles.dock}>
      <p className="eyebrow">
        Agents <span className={styles.countDot}>·</span> {agents.length}
      </p>
      <div className={styles.railWrap}>
        {edges.before && (
          <button
            type="button"
            className={`${styles.edge} ${styles.before}`}
            aria-label="Scroll to earlier agents"
            onClick={() => scrollRail(-1)}
          >
            <ChevronLeft size={18} aria-hidden />
          </button>
        )}
        <div
          ref={railRef}
          className={styles.rail}
          role="tablist"
          aria-label="Agents"
          onKeyDown={onTablistKey}
          onScroll={(event) => setEdges(rosterScrollEdges(event.currentTarget))}
        >
          {agents.map((agent) => {
            const selected = agent.name === selectedName;
            const hue = agent.color ?? 'var(--accent)';
            return (
              <button
                key={agent.name}
                ref={(el) => {
                  if (el) itemRefs.current.set(agent.name, el);
                  else itemRefs.current.delete(agent.name);
                }}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-label={agent.name}
                title={agent.name}
                tabIndex={selected ? 0 : -1}
                onClick={() => onSelect(agent.name)}
                data-testid={`agent-tab-${agent.name}`}
                className={cx(styles.item, selected && styles.on)}
                style={{ ['--hue' as string]: hue } as React.CSSProperties}
              >
                <span className={styles.glow} aria-hidden />
                <span className={styles.mark}>
                  <AgentAvatar name={agent.name} size={44} />
                  <ProviderBubble
                    provider={providerForAgent(agent)}
                    size={17}
                    className={styles.bubble}
                  />
                </span>
                {selected && (
                  <motion.span
                    layoutId="dock-selection"
                    className={styles.selectionBar}
                    transition={reduce ? { duration: 0 } : BAR_SPRING}
                    aria-hidden
                  />
                )}
              </button>
            );
          })}
          <button
            type="button"
            className={styles.newAgent}
            onClick={onCreate}
            aria-label="New agent"
            title="New agent"
            data-testid="agent-new"
          >
            <Plus size={16} aria-hidden />
          </button>
        </div>
        {edges.after && (
          <button
            type="button"
            className={`${styles.edge} ${styles.after}`}
            aria-label="Scroll to later agents"
            onClick={() => scrollRail(1)}
          >
            <ChevronRight size={18} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
