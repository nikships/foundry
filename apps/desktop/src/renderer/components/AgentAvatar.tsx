import { useBrandedAsset } from '../hooks/useBrandedAsset.js';
import { useApp } from '../stores/app.js';
import styles from './AgentAvatar.module.css';

export default function AgentAvatar({
  name,
  size = 28,
}: {
  name: string | null;
  size?: number;
}): React.JSX.Element {
  const { agentColor } = useApp();
  const src = useBrandedAsset(name ? `agents/${name}.png` : null);
  const color = agentColor(name);
  const initial = (name ?? '?').slice(0, 1).toUpperCase();

  return (
    <span
      className={`${styles.avatar} ${src ? styles.emblem : ''}`}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderColor: `color-mix(in srgb, ${color} ${src ? 72 : 45}%, transparent)`,
        background: src ? 'var(--bg-void)' : `color-mix(in srgb, ${color} 14%, var(--bg-raised))`,
        color,
        fontSize: `${Math.round(size * 0.42)}px`,
      }}
      title={name ?? undefined}
    >
      {src ? <img src={src} alt={name ?? ''} /> : initial}
    </span>
  );
}
