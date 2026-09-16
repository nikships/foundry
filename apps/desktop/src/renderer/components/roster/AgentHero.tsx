import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { AgentDef } from '@shared/types.js';
import { ProviderIcon } from '../media/BrandIcon.js';
import AgentMarkTrigger from '../media/AgentMarkTrigger.js';
import ProviderBubble from '../media/ProviderBubble.js';
import { EnvelopesEmblem } from '../layout/SidebarEmblems.js';
import { cx } from '../ui/cx.js';
import styles from './AgentHero.module.css';

const HERO_EASE = [0.4, 0, 0.2, 1] as const;
/** Compact portrait for the banner masthead (~96–112px). */
const PORTRAIT_SIZE = 104;

/**
 * Roster banner masthead for the selected agent: compact mark on the left,
 * name + meta + full-width purpose spanning the middle, and a right-hand
 * actions column. Open masthead — no card border or panel chrome (see #411).
 * Editing happens in the sections below; the hero keeps only the actions that
 * operate on the agent as a whole.
 */
export default function AgentHero({
  agent,
  provider,
  modelText,
  stale,
  onEditMark,
  onPreview,
  onDuplicate,
  onReset,
  onDelete,
}: {
  /** The live draft, so edits repaint the hero as they type. */
  agent: AgentDef;
  /** Vendor behind the model the agent would run with ('' when unknown). */
  provider: string;
  /** Display label of that model, inheritance sentinels already resolved. */
  modelText: string;
  /** A shipped agent whose shipped version has since changed. */
  stale: boolean;
  onEditMark: () => void;
  onPreview: () => void;
  onDuplicate: () => void;
  onReset: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const reduce = useReducedMotion();
  const hue = agent.color ?? 'var(--accent)';
  const transition = { duration: reduce ? 0 : 0.18, ease: HERO_EASE };

  return (
    <section
      className={styles.hero}
      aria-label={`${agent.name} details`}
      style={{ ['--hue' as string]: hue }}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={agent.name}
          className={styles.portrait}
          initial={reduce ? false : { opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, x: 8 }}
          transition={transition}
        >
          <span
            className={styles.glow}
            aria-hidden
            style={{ background: `radial-gradient(circle, ${hue} 0%, transparent 68%)` }}
          />
          <AgentMarkTrigger
            name={agent.name}
            emblem={agent.emblem}
            color={agent.color}
            size={PORTRAIT_SIZE}
            ring={2}
            onClick={onEditMark}
          />
          <ProviderBubble provider={provider} size={28} className={styles.portraitBubble} />
        </motion.div>
      </AnimatePresence>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={`${agent.name}-main`}
          className={styles.main}
          initial={reduce ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
          transition={transition}
        >
          <div className={styles.identity}>
            <h2 className={styles.name}>{agent.name}</h2>
            <div className={styles.meta}>
              <ProviderIcon provider={provider} size={14} />
              <span>{modelText}</span>
              <span className={styles.metaDot} aria-hidden />
              <span className={styles.metaEnvelope}>
                <EnvelopesEmblem size={13} />
                returns {agent.envelope}
              </span>
            </div>
          </div>
          <p className={styles.purpose}>{agent.purpose || 'No purpose yet.'}</p>
        </motion.div>
      </AnimatePresence>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={`${agent.name}-actions`}
          className={styles.actions}
          initial={reduce ? false : { opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, x: -8 }}
          transition={transition}
        >
          <button
            type="button"
            className={styles.action}
            onClick={onPreview}
            data-testid="agent-preview"
          >
            Preview prompt
          </button>
          <button
            type="button"
            className={styles.action}
            onClick={onDuplicate}
            data-testid="agent-duplicate"
          >
            Duplicate
          </button>
          {agent.builtin && stale && (
            <button
              type="button"
              className={styles.action}
              onClick={onReset}
              data-testid="agent-reset"
            >
              Reset to shipped version
            </button>
          )}
          {!agent.builtin && (
            <button
              type="button"
              className={cx(styles.action, styles.danger)}
              onClick={onDelete}
              data-testid="agent-delete"
            >
              Delete
            </button>
          )}
        </motion.div>
      </AnimatePresence>
    </section>
  );
}
