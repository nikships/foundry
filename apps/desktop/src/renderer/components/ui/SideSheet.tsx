import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useEscapeToClose } from '../../hooks/useEscapeToClose.js';
import { cx } from './cx.js';
import styles from './SideSheet.module.css';

/** One frame past --fast (120ms): how long the exit animation runs before the
 * sheet actually unmounts. */
const LEAVE_MS = 140;

/**
 * The one slide-over surface on a workbench screen: deep editing opens here so
 * the board behind it stays whole. Escape and a backdrop click both dismiss;
 * focus lands on the close control so keyboard users are not stranded behind
 * the panel.
 *
 * The slide is symmetric: when `open` flips false the sheet plays its exit and
 * only then unmounts, so every dismissal path animates identically.
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
  /** False once the exit animation has finished and nothing should render. */
  const [mounted, setMounted] = useState(open);
  /** True while the exit animation runs. */
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setLeaving(false);
      return;
    }
    setLeaving(true);
    const t = setTimeout(() => {
      setLeaving(false);
      setMounted(false);
    }, LEAVE_MS);
    return () => clearTimeout(t);
  }, [open]);

  useEscapeToClose(onClose, open);

  useEffect(() => {
    // preventScroll: the panel is still translated off-screen right on this
    // tick, and a focus scroll-into-view would drag the whole shell sideways
    // and snap it back when the slide-in resolves.
    if (open) closeRef.current?.focus({ preventScroll: true });
  }, [open]);

  if (!mounted) return null;

  const stop = (e: MouseEvent): void => e.stopPropagation();

  return (
    <div
      className={cx(styles.overlay, leaving && styles.overlayLeaving)}
      role="presentation"
      onClick={onClose}
    >
      <aside
        className={cx(styles.panel, leaving && styles.panelLeaving)}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-hidden={leaving || undefined}
        onClick={stop}
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
