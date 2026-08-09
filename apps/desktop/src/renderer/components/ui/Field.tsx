import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  /** Appended to the global `field` wrapper (e.g. grid-span helpers). */
  className?: string;
  children: ReactNode;
}

/**
 * Form field wrapper for the global `.field` layout: a column of label,
 * control, hint, error. The control is passed as children so non-input
 * controls (checkbox lists, chip groups, swatches) work too. When a site
 * needs a hint or error in a non-default position or tone, pass it as a child
 * instead of via the props.
 */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  className,
  children,
}: FieldProps): React.JSX.Element {
  return (
    <div className={className ? `field ${className}` : 'field'}>
      {label != null && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {hint && <span className="hint">{hint}</span>}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Monospace variant — paths, commands, identifiers. */
  mono?: boolean;
}

export function TextInput({ mono, className, ...rest }: TextInputProps): React.JSX.Element {
  return (
    <input className={['input', mono && 'mono', className].filter(Boolean).join(' ')} {...rest} />
  );
}

export function Select({
  className,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return <select className={['select', className].filter(Boolean).join(' ')} {...rest} />;
}

export function Textarea({
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  return <textarea className={['textarea', className].filter(Boolean).join(' ')} {...rest} />;
}
