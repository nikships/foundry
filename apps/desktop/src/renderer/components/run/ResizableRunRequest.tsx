import { useRef, useState } from 'react';
import styles from './ResizableRunRequest.module.css';

const DEFAULT_HEIGHT = 76;
const MIN_HEIGHT = 42;
const MAX_HEIGHT = 360;
const MAX_VIEWPORT_RATIO = 0.42;
const KEYBOARD_STEP = 16;

interface DragState {
  pointerId: number;
  startHeight: number;
  startY: number;
}

function maxRequestHeight(viewportHeight: number): number {
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, viewportHeight * MAX_VIEWPORT_RATIO));
}

export function runRequestHeight(
  startHeight: number,
  deltaY: number,
  viewportHeight: number,
): number {
  return Math.round(
    Math.min(maxRequestHeight(viewportHeight), Math.max(MIN_HEIGHT, startHeight + deltaY)),
  );
}

export default function ResizableRunRequest({ request }: { request: string }): React.JSX.Element {
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const dragRef = useRef<DragState | null>(null);
  const renderedHeight = runRequestHeight(height, 0, window.innerHeight);

  const resizeBy = (deltaY: number): void => {
    setHeight((current) => runRequestHeight(current, deltaY, window.innerHeight));
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startHeight: renderedHeight,
      startY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setHeight(runRequestHeight(drag.startHeight, event.clientY - drag.startY, window.innerHeight));
  };

  const finishDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      resizeBy(-KEYBOARD_STEP);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      resizeBy(KEYBOARD_STEP);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setHeight(MIN_HEIGHT);
    }
  };

  return (
    <div className={styles.frame}>
      <p className={`${styles.request} selectable`} style={{ height: renderedHeight }}>
        {request}
      </p>
      <div
        className={styles.resizeHandle}
        role="separator"
        aria-label="Resize run prompt"
        aria-orientation="horizontal"
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={Math.round(maxRequestHeight(window.innerHeight))}
        aria-valuenow={renderedHeight}
        tabIndex={0}
        title="Drag to resize the prompt. Double-click to reset."
        data-testid="run-prompt-resize"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onDoubleClick={() => setHeight(DEFAULT_HEIGHT)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
