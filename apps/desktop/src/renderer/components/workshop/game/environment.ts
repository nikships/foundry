import Phaser from 'phaser';
import type { WorkshopStation } from '../../../view-models/workshop-view.js';
import { benchAt, GROUND_Y, TEXT_RESOLUTION, WORLD_HEIGHT, worldWidth } from './world-layout.js';

function platform(
  scene: Phaser.Scene,
  x: number,
  y: number,
  width: number,
  group: Phaser.Physics.Arcade.StaticGroup,
): void {
  const graphics = scene.add.graphics().setDepth(12);
  graphics.fillStyle(0x071923).fillRoundedRect(x - width / 2, y + 7, width, 37, 6);
  graphics.fillStyle(0x40565b).fillRoundedRect(x - width / 2, y, width, 12, 3);
  graphics.fillStyle(0x9ab1a0).fillRect(x - width / 2 + 3, y, width - 6, 2);
  graphics.fillStyle(0x8b7249).fillRect(x - width / 2 + 8, y + 11, width - 16, 3);
  for (let at = x - width / 2 + 16; at < x + width / 2 - 8; at += 30) {
    graphics.fillStyle(0x809996).fillCircle(at, y + 24, 2);
    graphics.fillStyle(0x213b44).fillRect(at + 7, y + 19, 13, 11);
  }
  const led = scene.add.rectangle(x, y + 38, width - 24, 2, 0xdcb16b, 0.7).setDepth(13);
  scene.tweens.add({
    targets: led,
    alpha: 0.3,
    duration: 2100 + (x % 500),
    yoyo: true,
    repeat: -1,
  });
  const collider = scene.add.rectangle(x, y + 8, width, 16, 0xffffff, 0);
  group.add(collider);
}

function support(scene: Phaser.Scene, x: number, y: number): void {
  const g = scene.add.graphics().setDepth(2);
  g.lineStyle(9, 0x1a303a)
    .lineBetween(x - 85, y + 39, x - 85, GROUND_Y)
    .lineBetween(x + 85, y + 39, x + 85, GROUND_Y);
  g.lineStyle(2, 0x627165, 0.5)
    .lineBetween(x - 82, y + 39, x - 82, GROUND_Y)
    .lineBetween(x + 88, y + 39, x + 88, GROUND_Y);
  for (let at = y + 75; at < GROUND_Y - 10; at += 64) {
    g.lineStyle(5, 0x243c42).lineBetween(x - 82, at - 20, x + 82, at + 40);
    g.lineStyle(1, 0x66766a, 0.3).lineBetween(x - 79, at - 20, x + 85, at + 40);
  }
}

function connectingPipes(scene: Phaser.Scene, count: number): void {
  const g = scene.add.graphics().setDepth(1);
  for (let i = 1; i < count; i++) {
    const a = benchAt(i - 1);
    const b = benchAt(i);
    const bendY = Math.max(a.y, b.y) + 78;
    const path = new Phaser.Curves.Path(a.x + 100, a.y + 48);
    path
      .lineTo(a.x + 100, bendY)
      .lineTo(b.x - 100, bendY)
      .lineTo(b.x - 100, b.y + 48);
    g.lineStyle(15, 0x0b222c);
    path.draw(g);
    g.lineStyle(9, 0x42635f);
    path.draw(g);
    g.lineStyle(2, 0x98b199, 0.5);
    path.draw(g);
    scene.add
      .image((a.x + b.x) / 2, bendY, 'glow')
      .setTint(0x94d2b1)
      .setScale(0.6)
      .setAlpha(0.18)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(3);
  }
}

function hangingLamp(scene: Phaser.Scene, x: number, y: number): void {
  const g = scene.add.graphics().setDepth(3);
  g.lineStyle(3, 0x1c343b).lineBetween(x, 0, x, y);
  g.fillStyle(0x9a8151).fillTriangle(x - 28, y + 20, x + 28, y + 20, x, y);
  g.fillStyle(0xf0d695).fillEllipse(x, y + 20, 49, 6);
  scene.add
    .image(x, y + 22, 'glow')
    .setScale(1.4)
    .setTint(0xf2c177)
    .setAlpha(0.3)
    .setBlendMode(Phaser.BlendModes.ADD)
    .setDepth(4);
  const cone = scene.add.graphics().setDepth(0);
  cone.fillStyle(0xedc37f, 0.026).fillTriangle(x, y + 20, x - 100, y + 280, x + 100, y + 280);
}

export function buildEnvironment(
  scene: Phaser.Scene,
  stations: WorkshopStation[],
): Phaser.Physics.Arcade.StaticGroup {
  const width = worldWidth(stations.length);
  const platforms = scene.physics.add.staticGroup();
  const g = scene.add.graphics().setDepth(14);
  g.fillGradientStyle(0x152c35, 0x152c35, 0x071522, 0x071522).fillRect(0, GROUND_Y, width, 200);
  g.fillStyle(0x6f8070).fillRect(0, GROUND_Y, width, 4);
  g.fillStyle(0xb89a60, 0.65).fillRect(0, GROUND_Y + 5, width, 2);
  for (let x = 0; x < width; x += 82) {
    g.lineStyle(1, 0x3b4f50, 0.4).lineBetween(x, GROUND_Y + 15, x - 70, WORLD_HEIGHT);
    g.fillStyle(0x8b754f, 0.35).fillRect(x + 7, GROUND_Y + 16, 29, 5);
  }
  const ground = scene.add.rectangle(width / 2, GROUND_Y + 50, width, 100, 0, 0);
  platforms.add(ground);
  connectingPipes(scene, stations.length);
  stations.forEach((station, index) => {
    const bench = benchAt(index);
    support(scene, bench.x, bench.y);
    platform(scene, bench.x, bench.y, bench.width, platforms);
    hangingLamp(scene, bench.x + 30, bench.y - 250);
    const color = Phaser.Display.Color.HexStringToColor(station.color).color;
    const plate = scene.add
      .text(
        bench.x,
        bench.y + 61,
        `${String(index + 1).padStart(2, '0')}  /  ${station.phase.name.toUpperCase()}`,
        {
          fontFamily: 'Geist Mono, monospace',
          fontSize: '12px',
          color: '#becabd',
          backgroundColor: '#10252d',
          padding: { x: 13, y: 7 },
          resolution: TEXT_RESOLUTION,
        },
      )
      .setOrigin(0.5, 0)
      .setDepth(16);
    plate.setAlpha(0.9);
    scene.add.circle(bench.x - 98, bench.y + 76, 3, color).setDepth(17);
  });
  scene.add
    .particles(0, 0, 'spark', {
      x: { min: 0, max: width },
      y: { min: 150, max: GROUND_Y },
      lifespan: 7000,
      frequency: 140,
      speedX: { min: -9, max: 9 },
      speedY: { min: -15, max: -3 },
      scale: { start: 0.18, end: 0 },
      alpha: { start: 0.45, end: 0 },
      tint: [0xd9c891, 0x88ccbe],
      blendMode: Phaser.BlendModes.ADD,
    })
    .setDepth(25);
  return platforms;
}
