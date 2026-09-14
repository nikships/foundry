import AgentAvatar from './AgentAvatar.js';
import styles from './AgentMarkTrigger.module.css';

/**
 * Round click target over an agent's avatar that opens the mark picker. The
 * overlay ring lights on hover instead of repainting the avatar itself.
 */
export default function AgentMarkTrigger({
  name,
  emblem,
  color,
  size,
  ring,
  onClick,
}: {
  name: string;
  emblem?: string;
  color?: string;
  size: number;
  /** Ring thickness in px; absent keeps the avatar's default hairline. */
  ring?: number;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-mark-trigger
      aria-label={`Change mark for ${name}`}
      onClick={onClick}
      className={styles.trigger}
    >
      <AgentAvatar name={name} emblem={emblem} color={color} size={size} ring={ring} />
      <span className={styles.overlay} aria-hidden />
    </button>
  );
}
