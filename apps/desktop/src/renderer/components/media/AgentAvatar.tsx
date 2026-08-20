import { useBrandedAsset } from '../../hooks/useBrandedAsset.js';
import { useApp } from '../../stores/app.js';
import { resolveAgentMark } from '../../data/emblems.js';
import { Emblem } from './Emblem.js';
import styles from './AgentAvatar.module.css';

export default function AgentAvatar({
  name,
  size = 28,
  emblem,
  color: colorOverride,
}: {
  name: string | null;
  size?: number;
  /** Draft override; absent reads the saved agent. */
  emblem?: string;
  /** Draft override; absent reads the saved agent hue. */
  color?: string;
}): React.JSX.Element {
  const { agentByName, agentColor } = useApp();
  const saved = name ? agentByName(name) : null;
  const mark = resolveAgentMark(emblem ?? saved?.emblem);
  const src = useBrandedAsset(mark.imagePath ?? null);
  const color = colorOverride ?? agentColor(name);
  const initial = (name ?? '?').slice(0, 1).toUpperCase();
  const showImage = Boolean(src);
  const showGlyph = !showImage && mark.kind === 'emblem' && Boolean(mark.emblemId);

  return (
    <span
      className={`${styles.avatar} ${showImage ? styles.portrait : ''} ${showGlyph ? styles.glyph : ''}`}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderColor: `color-mix(in srgb, ${color} ${showImage ? 72 : 45}%, transparent)`,
        background: showImage
          ? 'var(--bg-void)'
          : `color-mix(in srgb, ${color} 14%, var(--bg-raised))`,
        color,
        fontSize: `${Math.round(size * 0.42)}px`,
      }}
      title={name ?? undefined}
    >
      {showImage ? (
        <img src={src} alt={name ?? ''} />
      ) : showGlyph ? (
        <Emblem id={mark.emblemId} size={Math.round(size * 0.62)} />
      ) : (
        initial
      )}
    </span>
  );
}
