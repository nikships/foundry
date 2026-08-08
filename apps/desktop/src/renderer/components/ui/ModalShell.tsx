import type { ReactNode, RefObject } from 'react';
import { useEscapeToClose } from '../../hooks/useEscapeToClose.js';
import styles from './ModalShell.module.css';

interface ModalShellProps {
  children: ReactNode;
  onClose?: () => void;
  /** Defaults to true. When false, backdrop click focuses sheet instead of closing, and Esc is not wired. */
  dismissible?: boolean;
  ariaLabelledBy?: string;
  className?: string;
  sheetRef?: RefObject<HTMLElement | null>;
  tabIndex?: number;
  /** Sets z-index to 100 and heavier blur (for interrupt sheets). Defaults to false (z-index 90). */
  highPriority?: boolean;
}

export function ModalShell({
  children,
  onClose,
  dismissible = true,
  ariaLabelledBy,
  className,
  sheetRef,
  tabIndex,
  highPriority = false,
}: ModalShellProps): React.JSX.Element {
  useEscapeToClose(onClose ?? (() => {}), Boolean(dismissible && onClose));

  const scrimClass = `${styles.scrim} ${highPriority ? styles.highPriority : ''}`;
  const sheetClass = className ? `${styles.sheet} ${className}` : styles.sheet;

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return;
    if (dismissible && onClose) {
      onClose();
    } else if (sheetRef?.current) {
      sheetRef.current.focus();
    }
  };

  return (
    <div
      className={scrimClass}
      role="presentation"
      onClick={dismissible ? handleBackdrop : undefined}
      onMouseDown={!dismissible ? handleBackdrop : undefined}
    >
      <section
        ref={sheetRef as RefObject<HTMLDivElement>}
        className={sheetClass}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabelledBy}
        tabIndex={tabIndex}
      >
        {children}
      </section>
    </div>
  );
}
