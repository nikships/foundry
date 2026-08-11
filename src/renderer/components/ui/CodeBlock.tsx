import type { CSSProperties, ReactNode } from 'react';
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
  const combinedClass = className
    ? `${styles.block} selectable ${className}`
    : `${styles.block} selectable`;

  const combinedStyle: CSSProperties | undefined =
    maxHeight !== undefined ? { ...style, maxHeight } : style;

  return (
    <pre className={combinedClass} style={combinedStyle}>
      {children}
    </pre>
  );
}
