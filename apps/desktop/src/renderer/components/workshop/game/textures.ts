import type Phaser from 'phaser';

type Paint = (ctx: CanvasRenderingContext2D) => void;

function texture(
  scene: Phaser.Scene,
  key: string,
  width: number,
  height: number,
  paint: Paint,
): void {
  const canvas = scene.textures.createCanvas(key, width, height);
  if (!canvas) return;
  paint(canvas.context);
  canvas.refresh();
}

function rounded(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fill: string,
  stroke?: string,
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function gradient(
  ctx: CanvasRenderingContext2D,
  top: string,
  middle: string,
  bottom: string,
  height: number,
): CanvasGradient {
  const fill = ctx.createLinearGradient(0, 0, 0, height);
  fill.addColorStop(0, top);
  fill.addColorStop(0.48, middle);
  fill.addColorStop(1, bottom);
  return fill;
}

function head(ctx: CanvasRenderingContext2D): void {
  ctx.shadowColor = '#03080f';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 4;
  const fill = ctx.createRadialGradient(50, 38, 6, 50, 50, 48);
  fill.addColorStop(0, '#1c242c');
  fill.addColorStop(0.62, '#0c1218');
  fill.addColorStop(1, '#04070b');
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(50, 50, 44, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.strokeStyle = '#42606a';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.strokeStyle = '#ffffff2b';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(50, 50, 36, Math.PI * 1.02, Math.PI * 1.42);
  ctx.stroke();
}

function body(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = gradient(ctx, '#eef2df', '#b9c9c4', '#536c7b', 58);
  ctx.beginPath();
  ctx.roundRect(5, 4, 46, 47, 14);
  ctx.fill();
  ctx.strokeStyle = '#d2e2d9';
  ctx.lineWidth = 2;
  ctx.stroke();
  rounded(ctx, 14, 15, 29, 28, 6, '#203e4d', '#66858d');
  rounded(ctx, 18, 20, 21, 7, 2, '#91c8c4');
  rounded(ctx, 20, 34, 7, 3, 1, '#edbd70');
  rounded(ctx, 30, 34, 7, 3, 1, '#a4e1c4');
  rounded(ctx, 8, 45, 41, 6, 2, '#354657');
}

function boot(ctx: CanvasRenderingContext2D): void {
  rounded(ctx, 7, 2, 15, 21, 5, '#566d7d', '#99b0ba');
  ctx.fillStyle = gradient(ctx, '#edf0dc', '#bdc9c5', '#71878f', 39);
  ctx.beginPath();
  ctx.roundRect(2, 16, 29, 17, 7);
  ctx.fill();
  rounded(ctx, 2, 30, 29, 5, 2, '#1e3042');
}

function arm(ctx: CanvasRenderingContext2D): void {
  rounded(ctx, 4, 1, 15, 28, 7, '#cadbd2', '#edf2dd');
  rounded(ctx, 2, 24, 19, 12, 6, '#506b7a', '#90a7a9');
  rounded(ctx, 5, 31, 16, 10, 5, '#d8ded0');
}

function terminal(ctx: CanvasRenderingContext2D): void {
  ctx.shadowColor = '#000a';
  ctx.shadowBlur = 10;
  rounded(ctx, 13, 9, 103, 67, 10, '#2b4654', '#718b8e');
  ctx.shadowBlur = 0;
  rounded(ctx, 20, 15, 89, 51, 5, '#112b3a', '#547983');
  const screen = ctx.createLinearGradient(20, 15, 110, 68);
  screen.addColorStop(0, '#174b54');
  screen.addColorStop(1, '#0f273a');
  ctx.fillStyle = screen;
  ctx.fill();
  const rows = [49, 65, 38, 58, 29];
  rows.forEach((width, index) => {
    ctx.fillStyle = index === 2 ? '#d9ab6b' : '#89d1c0';
    ctx.globalAlpha = index === 0 ? 1 : 0.65;
    ctx.fillRect(29, 25 + index * 7, width, 2);
  });
  ctx.globalAlpha = 1;
  rounded(ctx, 55, 76, 18, 22, 4, '#627883', '#99aaa2');
  rounded(ctx, 29, 95, 77, 7, 3, '#3e5866', '#809693');
  rounded(ctx, 0, 110, 132, 15, 4, '#57737a', '#a5afa0');
  rounded(ctx, 8, 126, 9, 46, 2, '#40535f', '#6c8586');
  rounded(ctx, 115, 126, 9, 46, 2, '#40535f', '#6c8586');
  for (let i = 0; i < 9; i++) rounded(ctx, 20 + i * 8, 112, 5, 3, 1, '#bac9b7');
  rounded(ctx, 100, 91, 14, 18, 3, '#ca9d68');
  ctx.strokeStyle = '#c79b65';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(114, 99, 5, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();
}

function parcel(ctx: CanvasRenderingContext2D): void {
  ctx.shadowColor = '#e4b15e66';
  ctx.shadowBlur = 12;
  rounded(ctx, 6, 7, 40, 39, 7, '#c29658', '#f8d58f');
  ctx.shadowBlur = 0;
  rounded(ctx, 20, 7, 11, 39, 1, '#e9d6a2');
  rounded(ctx, 9, 18, 34, 3, 1, '#654e3555');
  rounded(ctx, 12, 28, 12, 9, 2, '#ecedd8');
  ctx.fillStyle = '#4f716f';
  ctx.font = '8px monospace';
  ctx.fillText('<>', 13, 36);
}

export function createGameTextures(scene: Phaser.Scene): void {
  texture(scene, 'crew-head', 100, 100, head);
  texture(scene, 'crew-body', 57, 58, body);
  texture(scene, 'crew-boot', 34, 40, boot);
  texture(scene, 'crew-arm', 25, 44, arm);
  texture(scene, 'terminal', 136, 176, terminal);
  texture(scene, 'parcel', 54, 54, parcel);
  texture(scene, 'glow', 128, 128, (ctx) => {
    const fill = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    fill.addColorStop(0, '#ffffff');
    fill.addColorStop(0.15, '#ffffff88');
    fill.addColorStop(1, '#ffffff00');
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, 128, 128);
  });
  texture(scene, 'spark', 12, 12, (ctx) => {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(6, 6, 4, 0, Math.PI * 2);
    ctx.fill();
  });
}
