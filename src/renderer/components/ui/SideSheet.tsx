import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useEscapeToClose } from '../../hooks/useEscapeToClose.js';
import styles from './SideSheet.module.css';

/**
 * The one slide-over surface on a workbench screen: deep editing opens here so
 * the board behind it stays whole. Escape and a backdrop click both dismiss;
 * focus lands on the close control so keyboard users are not stranded behind
 * the panel.
 */
export function SideSheet({
  open,
  onClose,
  label,
  eyebrow,
  title,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  eyebrow: ReactNode;
  title: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}): React.JSX.Element | null {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEscapeToClose(onClose, open);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className={styles.overlay} role="presentation" onClick={onClose}>
      <aside
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <div className={styles.titleGroup}>
            <span className="eyebrow">{eyebrow}</span>
            <div className={styles.title}>{title}</div>
          </div>
          <button
            ref={closeRef}
            type="button"
            className={styles.closeBtn}
            aria-label={`Close ${label}`}
            title="Close (Esc)"
            onClick={onClose}
          >
            <X size={14} strokeWidth={1.6} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.body}>{children}</div>

        {footer && <div className={styles.footer}>{footer}</div>}
      </aside>
    </div>
  );
}
