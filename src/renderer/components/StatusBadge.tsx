import { statusColor, statusWord } from '../format.js';
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
  const text = label ?? statusWord(status);
  const spinning = status === 'running';
  return (
    <span
      className="badge"
      style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {dot && (
        <span
          className={`${styles.dot} ${spinning ? styles.spinning : ''}`}
          style={{ background: color }}
        />
      )}
      {text}
    </span>
  );
}
