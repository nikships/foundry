import { statusColor, statusWord } from '../../utils/format.js';
import { cx } from '../ui/cx.js';
import styles from './StatusBadge.module.css';

export default function StatusBadge({
  status,
  label,
  dot = true,
}: {
  status: string;
  label?: string;
  dot?: boolean;
}): React.JSX.Element {
  const color = statusColor(status);
  return (
    <span
      className="badge"
      style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {dot && (
        <span
          className={cx(styles.dot, status === 'running' && styles.spinning)}
          style={{ background: color }}
        />
      )}
      {label ?? statusWord(status)}
    </span>
  );
}
