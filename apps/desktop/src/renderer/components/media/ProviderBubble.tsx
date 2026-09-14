import { cx } from '../ui/cx.js';
import { ProviderIcon, providerMark } from './BrandIcon.js';
import styles from './ProviderBubble.module.css';

/**
 * The backing model's brand mark in a small circular chip, anchored to an
 * agent's portrait. A provider this build has no mark for leaves no bubble —
 * the same honest gap BrandIcon documents for the bare icon.
 */
export default function ProviderBubble({
  provider,
  size,
  className,
}: {
  provider: string;
  size: number;
  className?: string;
}): React.JSX.Element | null {
  if (!providerMark(provider)) return null;
  return (
    <span
      className={cx(styles.bubble, className)}
      style={{ width: size, height: size }}
      title={provider}
    >
      <ProviderIcon provider={provider} size={Math.max(8, Math.round(size * 0.6))} />
    </span>
  );
}
