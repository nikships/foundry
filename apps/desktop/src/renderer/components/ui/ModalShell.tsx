import type { MouseEvent, ReactNode, RefObject } from 'react';
import { useEscapeToClose } from '../../hooks/useEscapeToClose.js';
import { cx } from './cx.js';
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
  /** Plays the exit animation instead of the entrance. Surfaces that delay their unmount until the exit finishes set this for those frames. */
  leaving?: boolean;
  'data-testid'?: string;
}

const noop = (): void => {};

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
  leaving = false,
  'data-testid': dataTestId,
}: ModalShellProps): React.JSX.Element {
  const resolvedRef = modalRef ?? sheetRef;
  const closeOnBackdrop = dismissible && Boolean(onClose);
  useEscapeToClose(onClose ?? noop, closeOnBackdrop && !leaving);

  const handleBackdrop = (e: MouseEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return;
    if (closeOnBackdrop) onClose?.();
    else resolvedRef?.current?.focus();
  };

  return (
    <div
      className={cx(
        styles.overlayBackdrop,
        highPriority && styles.highPriority,
        leaving && styles.overlayBackdropLeaving,
      )}
      role="presentation"
      onClick={dismissible ? handleBackdrop : undefined}
      onMouseDown={dismissible ? undefined : handleBackdrop}
    >
      <section
        ref={resolvedRef}
        className={cx(styles.modal, className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabelledBy}
        tabIndex={tabIndex}
        data-testid={dataTestId}
      >
        {children}
      </section>
    </div>
  );
}
