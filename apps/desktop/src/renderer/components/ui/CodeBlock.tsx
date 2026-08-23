import type { CSSProperties, ReactNode } from 'react';
import { cx } from './cx.js';
import styles from './CodeBlock.module.css';

interface CodeBlockProps {
  children: ReactNode;
  className?: string;
  maxHeight?: number | string;
  style?: CSSProperties;
}

/**
 * Shared pre formatted mono block. Replaces duplicated `.block` / `.raw` / `.output`
 * pre styling across DryRunSheet, PromptPreview, PhaseDrawer, DetectionPanel,
 * ProjectCommands, and JsonView.
 */
export function CodeBlock({
  children,
  className,
  maxHeight,
  style,
}: CodeBlockProps): React.JSX.Element {
  return (
    <pre
      className={cx(styles.block, 'selectable', className)}
      style={maxHeight === undefined ? style : { ...style, maxHeight }}
    >
      {children}
    </pre>
  );
}
