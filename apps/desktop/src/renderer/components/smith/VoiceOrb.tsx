import { useEffect, useRef } from 'react';
import styles from './SmithVoiceOverlay.module.css';

/** A sampled speaker signal deforms a field of latitude filaments; no React updates per frame. */
export function VoiceOrb({
  active,
  speaking,
  readLevel,
}: {
  active: boolean;
  speaking: boolean;
  readLevel: () => number;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = 280 * ratio;
    canvas.height = 210 * ratio;
    context.scale(ratio, ratio);
    let frame = 0;
    let energy = 0;
    let phase = 0;
    let last = 0;
    const render = (now: number): void => {
      const delta = Math.min((now - last) / 1000, 0.05);
      last = now;
      energy += (readLevel() - energy) * 0.18;
      if (!motion.matches) phase += delta * (speaking ? 1.4 : 0.35);
      drawOrb(context, phase, motion.matches ? 0 : energy, active);
      if (active && !document.hidden && !motion.matches) frame = requestAnimationFrame(render);
    };
    const restart = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(render);
    };
    restart();
    document.addEventListener('visibilitychange', restart);
    motion.addEventListener('change', restart);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', restart);
      motion.removeEventListener('change', restart);
    };
  }, [active, speaking, readLevel]);
  return <canvas ref={canvasRef} className={styles.orb} aria-hidden="true" />;
}

function drawOrb(
  context: CanvasRenderingContext2D,
  phase: number,
  energy: number,
  active: boolean,
): void {
  context.clearRect(0, 0, 280, 210);
  const radius = 75 + energy * 12;
  const glow = context.createRadialGradient(140, 105, 20, 140, 105, 110);
  glow.addColorStop(0, `rgba(238, 112, 48, ${active ? 0.12 + energy * 0.12 : 0.035})`);
  glow.addColorStop(1, 'rgba(238, 112, 48, 0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, 280, 210);
  for (let line = 0; line < 34; line++) {
    const latitude = (line / 33) * Math.PI;
    const width = Math.sin(latitude) * radius;
    const y = Math.cos(latitude) * radius;
    context.beginPath();
    for (let step = 0; step <= 100; step++) {
      const angle = (step / 100) * Math.PI * 2;
      const ripple = Math.sin(angle * 3 + phase + latitude * 4) * (3 + energy * 11);
      const x = Math.cos(angle) * (width + ripple * Math.sin(latitude));
      const depth = Math.sin(angle) * width * 0.24;
      const py = y + depth + Math.sin(angle * 2 - phase + latitude * 3) * (4 + energy * 7);
      const px = 140 + x * 0.96 - py * 0.18;
      const screenY = 105 + py * 0.96 + x * 0.18;
      if (step === 0) context.moveTo(px, screenY);
      else context.lineTo(px, screenY);
    }
    context.closePath();
    context.strokeStyle = active
      ? `rgba(255, ${145 + Math.round(Math.sin(latitude) * 40)}, 92, ${0.3 + Math.sin(latitude) * 0.35 + energy * 0.2})`
      : 'rgba(163, 151, 140, 0.3)';
    context.lineWidth = 0.65 + energy * 0.4;
    context.stroke();
  }
}
