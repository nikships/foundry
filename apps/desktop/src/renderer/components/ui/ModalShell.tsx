import type { ReactNode, RefObject } from 'react';
import { useEscapeToClose } from '../../hooks/useEscapeToClose.js';
import styles from './ModalShell.module.css';

interface ModalShellProps {
  children: ReactNode;
  onClose?: () => void;
  /** Defaults to true. When false, backdrop click focuses dialog instead of closing, and Esc is not wired. */
  dismissible?: boolean;
  ariaLabelledBy?: string;
  className?: string;
  modalRef?: RefObject<HTMLElement | null>;
  /** @deprecated Use modalRef instead. */
  sheetRef?: RefObject<HTMLElement | null>;
  tabIndex?: number;
  /** Sets z-index to 100 and heavier blur (for interrupt dialogs). Defaults to false (z-index 90). */
  highPriority?: boolean;
}

export function ModalShell({
  children,
  onClose,
  dismissible = true,
  ariaLabelledBy,
  className,
  modalRef,
  sheetRef,
  tabIndex,
  highPriority = false,
}: ModalShellProps): React.JSX.Element {
  useEscapeToClose(onClose ?? (() => {}), Boolean(dismissible && onClose));

  const resolvedRef = modalRef ?? sheetRef;
  const overlayBackdropClass = `${styles.overlayBackdrop} ${highPriority ? styles.highPriority : ''}`;
  const modalClass = className ? `${styles.modal} ${className}` : styles.modal;

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return;
    if (dismissible && onClose) {
      onClose();
    } else if (resolvedRef?.current) {
      resolvedRef.current.focus();
    }
  };

  return (
    <div
      className={overlayBackdropClass}
      role="presentation"
      onClick={dismissible ? handleBackdrop : undefined}
      onMouseDown={!dismissible ? handleBackdrop : undefined}
    >
      <section
        ref={resolvedRef as RefObject<HTMLDivElement>}
        className={modalClass}
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
