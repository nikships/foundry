import type { ButtonHTMLAttributes, Ref } from 'react';

type ButtonVariant = 'primary' | 'danger' | 'ghost';
type ButtonSize = 'sm';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual variant. Omit for the default neutral button. */
  variant?: ButtonVariant;
  /** Compact size. Omit for the default height. */
  size?: ButtonSize;
  /** Ref to the underlying button (e.g. for autofocus). */
  ref?: Ref<HTMLButtonElement>;
}

/**
 * The global `.btn` primitive (tokens-base.css) with its `primary` / `danger` /
 * `ghost` variants and `sm` size as props. Extra classes (e.g. a layout hook
 * from a CSS module) pass through `className`. All other button attributes
 * (onClick, disabled, title, type, children, ref) spread through unchanged.
 */
export function Button({ variant, size, className, ref, ...rest }: ButtonProps): React.JSX.Element {
  return (
    <button
      ref={ref}
      className={['btn', variant, size, className].filter(Boolean).join(' ')}
      {...rest}
    />
  );
}
