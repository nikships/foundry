import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cx } from './cx.js';
import styles from './Dropdown.module.css';

export interface DropdownOption {
  value: string;
  label: ReactNode;
  /** Secondary line under the label (agent purpose, envelope blurb, etc.). */
  description?: ReactNode;
  /** Leading glyph (avatar, CLI mark, etc.). */
  icon?: ReactNode;
  /** Options that share a group label render under a section header. */
  group?: string;
  disabled?: boolean;
  /** Custom render function for option content inside the dropdown menu. */
  render?: (option: DropdownOption, helpers: { close: () => void }) => ReactNode;
  /** Render a divider line after this option in the menu. */
  divider?: boolean;
}

export interface DropdownProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  /** Extra classes on the root wrapper. */
  className?: string;
  /** Extra classes on the face button. Defaults include the global `.select`. */
  triggerClassName?: string;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  placeholder?: string;
  /** Override the closed-face content. Defaults to the selected option's label. */
  renderValue?: (option: DropdownOption | null) => ReactNode;
  /**
   * Menu sizing. `wide` (default) opens at least 320px for rich option
   * content; `compact` hugs the trigger for short plain-label option sets.
   * Both stay viewport-clamped.
   */
  menuWidth?: 'wide' | 'compact';
  /** Test ID for the trigger button, so agent-browser can target it reliably. */
  'data-testid'?: string;
}

interface MenuPos {
  top: number;
  left: number;
  /** Fixed menu width, or null when the menu sizes to its own content. */
  width: number | null;
  maxHeight: number;
  openUp: boolean;
}

const MENU_GAP = 4;
const VIEWPORT_PAD = 8;
const MIN_MENU_WIDTH = 320;
const MIN_COMPACT_MENU_WIDTH = 120;

function samePos(a: MenuPos, b: MenuPos): boolean {
  return (
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.maxHeight === b.maxHeight &&
    a.openUp === b.openUp
  );
}

/**
 * Whether the trigger still paints anywhere. A portaled menu is positioned
 * against the viewport, so an anchor scrolled under a clipping ancestor is
 * gone from the operator's view even while its rect sits inside the window.
 */
function anchorVisible(trigger: HTMLElement): boolean {
  const rect = trigger.getBoundingClientRect();
  let top = 0;
  let bottom = window.innerHeight;
  for (let node = trigger.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY === 'visible') continue;
    const clip = node.getBoundingClientRect();
    top = Math.max(top, clip.top);
    bottom = Math.min(bottom, clip.bottom);
  }
  return rect.bottom > top && rect.top < bottom;
}

/**
 * Themed listbox that replaces native `<select>`. The closed face reuses the
 * global `.select` chrome so existing layouts keep their look; the open menu is
 * a portaled, keyboard-navigable list that can show icons and descriptions.
 */
export function Dropdown({
  value,
  options,
  onChange,
  className,
  triggerClassName,
  disabled,
  id,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
  placeholder = 'Select…',
  renderValue,
  menuWidth = 'wide',
  'data-testid': dataTestId,
}: DropdownProps): React.JSX.Element {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  const selected = useMemo(() => options.find((o) => o.value === value) ?? null, [options, value]);
  const enabledIndexes = useMemo(
    () => options.flatMap((option, index) => (option.disabled ? [] : [index])),
    [options],
  );

  const close = useCallback((): void => {
    setOpen(false);
    setPos(null);
    setActiveIndex(-1);
  }, []);

  /** Re-anchors the menu to the trigger. False once the trigger is out of sight. */
  const measure = useCallback((): boolean => {
    const trigger = triggerRef.current;
    if (!trigger) return false;
    const rect = trigger.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;
    const spaceBelow = viewportH - rect.bottom - VIEWPORT_PAD;
    const spaceAbove = rect.top - VIEWPORT_PAD;
    const openUp = spaceBelow < 200 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(
      140,
      Math.min(480, openUp ? spaceAbove - MENU_GAP : spaceBelow - MENU_GAP),
    );
    // A compact menu hugs its own short labels instead of stretching to a
    // full-width trigger; the render pass below clamps it back on screen.
    const width =
      menuWidth === 'compact'
        ? null
        : Math.min(Math.max(rect.width, MIN_MENU_WIDTH), viewportW - VIEWPORT_PAD * 2);
    let left = rect.left;
    if (width !== null && left + width > viewportW - VIEWPORT_PAD) {
      left = Math.max(VIEWPORT_PAD, viewportW - VIEWPORT_PAD - width);
    }
    const next: MenuPos = {
      top: openUp ? rect.top - MENU_GAP : rect.bottom + MENU_GAP,
      left,
      width,
      maxHeight,
      openUp,
    };
    // Re-anchoring now runs per scroll frame, so skip the render when nothing moved.
    setPos((prev) => (prev && samePos(prev, next) ? prev : next));
    return anchorVisible(trigger);
  }, [menuWidth]);

  const openMenu = useCallback((): void => {
    if (disabled) return;
    measure();
    const start =
      enabledIndexes.find((i) => options[i]?.value === value) ?? enabledIndexes[0] ?? -1;
    setActiveIndex(start);
    setOpen(true);
  }, [disabled, enabledIndexes, measure, options, value]);

  const toggle = useCallback((): void => {
    if (open) close();
    else openMenu();
  }, [close, open, openMenu]);

  const pick = useCallback(
    (option: DropdownOption): void => {
      if (option.disabled) return;
      onChange(option.value);
      close();
      triggerRef.current?.focus();
    },
    [close, onChange],
  );

  const pickActive = useCallback((): void => {
    const option = activeIndex >= 0 ? options[activeIndex] : undefined;
    if (option) pick(option);
  }, [activeIndex, options, pick]);

  const moveActive = useCallback(
    (delta: number): void => {
      if (!enabledIndexes.length) return;
      setActiveIndex((prev) => {
        const currentPos = enabledIndexes.indexOf(prev);
        const nextPos =
          currentPos < 0
            ? delta > 0
              ? 0
              : enabledIndexes.length - 1
            : (currentPos + delta + enabledIndexes.length) % enabledIndexes.length;
        return enabledIndexes[nextPos]!;
      });
    },
    [enabledIndexes],
  );

  useLayoutEffect(() => {
    if (!open) return;
    measure();
  }, [open, measure, options.length]);

  // A content-sized menu's width is only known after it paints; nudge it back
  // inside the viewport once measured rather than guessing beforehand.
  useLayoutEffect(() => {
    if (!open || !pos || pos.width !== null) return;
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const maxLeft = window.innerWidth - VIEWPORT_PAD - rect.width;
    const left = Math.max(VIEWPORT_PAD, Math.min(pos.left, maxLeft));
    if (left !== pos.left) setPos({ ...pos, left });
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      close();
    };
    const onScroll = (e: Event): void => {
      // Scrolls inside the menu move its own list, not the trigger.
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
        return;
      }
      // An ancestor scrolled, so the anchor moved. Follow the trigger rather
      // than closing: the browser scrolls a focused control into view when the
      // menu opens, and closing on that would dismiss the menu the click just
      // opened. Only a trigger scrolled clear out of view dismisses it.
      if (!measure()) close();
    };
    const onResize = (): void => close();
    document.addEventListener('mousedown', onPointer);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close, measure]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const el = menuRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) openMenu();
      else moveActive(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (open) pickActive();
      else openMenu();
      return;
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      // Escape means "close this menu", not the sheet or modal hosting the
      // trigger — window-level Escape-to-close listeners must not also fire.
      e.stopPropagation();
      close();
    }
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      if (enabledIndexes.length) setActiveIndex(enabledIndexes[0]!);
    } else if (e.key === 'End') {
      e.preventDefault();
      if (enabledIndexes.length) setActiveIndex(enabledIndexes[enabledIndexes.length - 1]!);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pickActive();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      // Same shield as the trigger: dismissing the menu must not bubble on to
      // close a hosting sheet in the same keystroke.
      if (e.key === 'Escape') e.stopPropagation();
      close();
      triggerRef.current?.focus();
    }
  };

  const face = renderValue
    ? renderValue(selected)
    : selected
      ? selected.label
      : value || placeholder;

  const menuStyle: CSSProperties | undefined = pos
    ? {
        top: pos.openUp ? undefined : pos.top,
        bottom: pos.openUp ? window.innerHeight - pos.top : undefined,
        left: pos.left,
        width: pos.width ?? undefined,
        minWidth: pos.width === null ? MIN_COMPACT_MENU_WIDTH : undefined,
        maxWidth: pos.width === null ? window.innerWidth - VIEWPORT_PAD * 2 : undefined,
        maxHeight: pos.maxHeight,
      }
    : undefined;

  let lastGroup: string | undefined;

  return (
    <div ref={rootRef} className={cx(styles.root, className)}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={cx('select', styles.trigger, triggerClassName)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        data-testid={dataTestId}
        onClick={toggle}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={styles.face}>{face}</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            id={listId}
            className={styles.menu}
            style={menuStyle}
            role="listbox"
            tabIndex={-1}
            aria-activedescendant={activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined}
            onKeyDown={onMenuKeyDown}
          >
            {options.length === 0 && <div className={styles.empty}>No options</div>}
            {options.map((option, index) => {
              const showGroup = option.group && option.group !== lastGroup;
              if (option.group) lastGroup = option.group;
              const isSelected = option.value === value;
              const isActive = index === activeIndex;
              return (
                <div key={`${option.group ?? ''}:${option.value}:${index}`}>
                  {showGroup && (
                    <div className={styles.group} role="presentation">
                      {option.group}
                    </div>
                  )}
                  <div
                    id={`${listId}-opt-${index}`}
                    role="option"
                    data-index={index}
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    className={cx(
                      option.render ? styles.customOption : styles.option,
                      isActive && styles.active,
                      option.disabled && styles.disabled,
                      !option.render && isSelected && styles.selected,
                      !option.render && Boolean(option.description) && styles.rich,
                    )}
                    onMouseEnter={() => {
                      if (!option.disabled) setActiveIndex(index);
                    }}
                    onMouseDown={(e) => {
                      // Prevent the trigger from stealing focus before click fires.
                      e.preventDefault();
                    }}
                    onClick={() => {
                      if (!option.render) pick(option);
                    }}
                  >
                    {option.render ? (
                      option.render(option, { close })
                    ) : (
                      <>
                        {option.icon && <span className={styles.icon}>{option.icon}</span>}
                        <span className={styles.body}>
                          <span className={styles.label}>{option.label}</span>
                          {option.description != null && option.description !== '' && (
                            <span className={styles.description}>{option.description}</span>
                          )}
                        </span>
                        {isSelected && (
                          <span className={styles.check} aria-hidden>
                            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                              <path
                                d="M2.5 7.2 5.6 10.2 11.5 3.8"
                                stroke="currentColor"
                                strokeWidth="1.6"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  {option.divider && <div className={styles.divider} />}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
