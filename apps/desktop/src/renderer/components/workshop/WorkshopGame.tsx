import { createElement, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { providerMark } from '../media/BrandIcon.js';
import { workshopBrand } from '../../view-models/workshop-view.js';
import type { WorkshopGameHandle, WorkshopGameState } from './game/game-types.js';
import styles from './WorkshopGame.module.css';

const OBSERVATORY_URL = new URL('../../assets/workshop/observatory.png', import.meta.url).href;

/**
 * Phaser's loader XHRs its files, which the renderer CSP refuses for file://
 * builds. An <img> decode is governed by img-src (which allows file:), so the
 * painting arrives as an element the scene can adopt as a texture directly.
 */
async function loadBackdrop(): Promise<HTMLImageElement | null> {
  try {
    const image = new Image();
    image.src = OBSERVATORY_URL;
    await image.decode();
    return image;
  } catch {
    return null;
  }
}

async function loadLogo(model: string): Promise<HTMLImageElement | null> {
  const Mark = providerMark(workshopBrand(model));
  if (!Mark) return null;
  // Use the already-loaded client renderer, not a second React server bundle.
  await Promise.resolve();
  const container = document.createElement('div');
  const root = createRoot(container);
  flushSync(() => root.render(createElement(Mark, { size: 64 })));
  const svg = container.innerHTML;
  root.unmount();
  const image = new Image();
  // Monochrome marks inherit currentColor; pick one that reads on the black head.
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replaceAll('currentColor', '#e6f1e8'))}`;
  await image.decode();
  return image;
}

export default function WorkshopGame({
  state,
  focusId,
  focusNonce,
}: {
  state: WorkshopGameState;
  focusId?: string;
  focusNonce: number;
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const game = useRef<WorkshopGameHandle | null>(null);
  const latest = useRef(state);
  const [error, setError] = useState('');
  useEffect(() => {
    latest.current = state;
    game.current?.update(state);
  }, [state]);
  useEffect(() => {
    let disposed = false;
    void Promise.all([import('./game/scene.js'), loadBackdrop()])
      .then(([{ createWorkshopGame }, backdrop]) => {
        if (disposed || !host.current) return;
        game.current = createWorkshopGame(host.current, latest.current, loadLogo, backdrop);
      })
      .catch((reason: unknown) => {
        if (!disposed)
          setError(reason instanceof Error ? reason.message : 'Could not start the game renderer.');
      });
    return () => {
      disposed = true;
      game.current?.destroy();
      game.current = null;
    };
  }, []);
  useEffect(() => {
    game.current?.focus(focusId);
  }, [focusId, focusNonce]);

  return (
    <>
      <div
        ref={host}
        className={styles.game}
        data-testid="workshop-game"
        role="img"
        aria-label="A living 2D factory. Agents work, stretch and wander at their workbenches. Drag to explore; click a coworker to make it jump."
      />
      {error && (
        <div className={styles.error} role="alert">
          The game renderer could not start. {error} The live log and Inspector are still available.
        </div>
      )}
      <div className={styles.camera}>
        <span>
          DRAG TO EXPLORE <i /> CLICK A COWORKER
        </span>
        <div>
          <button onClick={() => game.current?.zoom(-1)} aria-label="Zoom out">
            <Minus size={14} />
          </button>
          <button
            onClick={() => game.current?.focus()}
            title="Follow current phase"
            aria-label="Follow current phase"
          >
            <Maximize2 size={13} />
          </button>
          <button onClick={() => game.current?.zoom(1)} aria-label="Zoom in">
            <Plus size={14} />
          </button>
        </div>
      </div>
    </>
  );
}
