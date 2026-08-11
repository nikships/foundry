import { useCallback, useEffect, useRef } from 'react';
import type { ValidationIssue } from '@shared/types.js';

/** Result of a persisted save: `ok` with any issues the backend reported. */
interface SaveOutcome {
  ok: boolean;
  issues: ValidationIssue[];
}

interface UseDebouncedSaveOptions<T> {
  /** Current draft. A falsy value means nothing to save (no selection). */
  value: T | null;
  /** Debounce delay in ms. */
  delay: number;
  /** Skip scheduling while true (e.g. live validation errors present). */
  disabled?: boolean;
  /**
   * When true, a draft with no persisted counterpart is dropped instead of
   * saved. Roster/Pipeline drafts upsert by name/id (so a new item is created),
   * but a Project draft only edits an existing project — saving one with no
   * persisted record would re-create a just-deleted project.
   */
  requirePersisted?: boolean;
  /** Returns the persisted snapshot to diff against, or null if none. */
  compare: (value: T) => T | null;
  /**
   * Optional re-validation at save time. If it returns any error-level issue
   * the save is skipped and `onIssues` receives them.
   */
  validate?: (value: T) => Promise<ValidationIssue[]>;
  /** Persist the snapshot. Serialisation is handled by the api guard in api.ts. */
  save: (value: T) => Promise<SaveOutcome>;
  /** Called with the saved snapshot after a successful save. */
  onSuccess?: (value: T) => Promise<void> | void;
  /** Called when validation or save reports issues. */
  onIssues?: (issues: ValidationIssue[]) => void;
  /** Called when save throws. */
  onError?: (error: Error) => void;
}

export interface UseDebouncedSaveApi {
  /** Persist any pending snapshot now (used on switch / rename / commit). */
  flush: () => Promise<void>;
  /** Drop any pending snapshot without saving (used before delete). */
  cancel: () => void;
}

/**
 * Live auto-save for a single editable record. Schedules a debounced flush
 * shortly after `value` settles, persists once per pause (not once per
 * keystroke), and flushes on unmount so a pending edit is not lost when the
 * user navigates away. Call `flush()` on an explicit switch and `cancel()`
 * before a delete so a queued save cannot re-create the removed record.
 */
export function useDebouncedSave<T>(opts: UseDebouncedSaveOptions<T>): UseDebouncedSaveApi {
  const { value, delay, disabled = false, requirePersisted = false } = opts;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<T | null>(null);
  // Latest callbacks/value live in a ref so `flush` and the effects stay stable
  // and the debounce effect only re-runs when the draft or gate actually moves.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  /** Writes the pending snapshot now (clearing any pending timer first). */
  const flush = useCallback(async (): Promise<void> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const toSave = pendingRef.current;
    pendingRef.current = null;
    if (!toSave) return;
    const { compare, validate, save, onSuccess, onIssues, onError, requirePersisted } =
      optsRef.current;
    const persisted = compare(toSave);
    if (requirePersisted && !persisted) return;
    if (JSON.stringify(toSave) === JSON.stringify(persisted)) return;
    try {
      if (validate) {
        const issues = await validate(toSave);
        if (issues.some((i) => i.level === 'error')) {
          onIssues?.(issues);
          return;
        }
      }
      const result = await save(toSave);
      if (!result.ok) {
        onIssues?.(result.issues);
        return;
      }
      await onSuccess?.(toSave);
    } catch (e) {
      onError?.(e as Error);
    }
  }, []);

  const cancel = useCallback((): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
  }, []);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Schedule a flush shortly after the value settles. The cleanup clears the
  // timer on every change so we persist once per pause, not once per keystroke.
  useEffect(() => {
    if (!value) return;
    if (disabled) return;
    const persisted = optsRef.current.compare(value);
    if (requirePersisted && !persisted) return;
    if (JSON.stringify(value) === JSON.stringify(persisted)) return;
    pendingRef.current = value;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void flushRef.current(), delay);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [value, disabled, delay, requirePersisted]);

  // An unmount is the last chance to persist; callers flush on switch.
  useEffect(() => () => void flushRef.current(), []);

  return { flush, cancel };
}
