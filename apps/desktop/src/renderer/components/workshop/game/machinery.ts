import Phaser from 'phaser';
import type { WorkshopStation } from '../../../view-models/workshop-view.js';
import { benchAt, TEXT_RESOLUTION } from './world-layout.js';

export class WorkMachine {
  private readonly arm: Phaser.GameObjects.Container;
  private readonly gauge: Phaser.GameObjects.Graphics;
  private readonly sparks: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly light: Phaser.GameObjects.Image;
  private readonly label: Phaser.GameObjects.Text;
  private active = false;
  private pulseAt = 0;
  private readonly color: number;
  private readonly x: number;
  private readonly y: number;

  constructor(
    scene: Phaser.Scene,
    readonly station: WorkshopStation,
    index: number,
  ) {
    const bench = benchAt(index);
    this.x = bench.x;
    this.y = bench.y;
    this.color = Phaser.Display.Color.HexStringToColor(station.color).color;
    const g = scene.add.graphics().setDepth(18);
    g.fillStyle(0x142f3b).fillRoundedRect(this.x - 65, this.y - 41, 136, 41, 8);
    g.lineStyle(2, 0x6e8988).strokeRoundedRect(this.x - 65, this.y - 41, 136, 41, 8);
    g.fillStyle(0x425c64).fillRoundedRect(this.x - 10, this.y - 86, 43, 50, 6);
    g.lineStyle(3, 0x91a99e).strokeRoundedRect(this.x - 10, this.y - 86, 43, 50, 6);
    for (let i = 0; i < 8; i++) {
      g.fillStyle(i % 2 ? 0x2a444b : 0xbaa367).fillRect(this.x - 57 + i * 15, this.y - 12, 10, 6);
    }
    this.arm = scene.add.container(this.x + 10, this.y - 69).setDepth(19);
    const armGraphics = scene.add.graphics();
    armGraphics.lineStyle(26, 0x15333f).lineBetween(0, 0, -44, -58).lineBetween(-44, -58, 2, -119);
    armGraphics.lineStyle(16, 0xbfa779).lineBetween(0, 0, -44, -58).lineBetween(-44, -58, 2, -119);
    armGraphics
      .lineStyle(3, 0xf4ddb0)
      .lineBetween(-4, -5, -48, -58)
      .lineBetween(-48, -58, -2, -119);
    armGraphics.fillStyle(0x324c58).fillCircle(-44, -58, 17);
    armGraphics.lineStyle(3, 0xaab5a0).strokeCircle(-44, -58, 14);
    armGraphics.fillStyle(0xd4ba85).fillCircle(-44, -58, 6);
    armGraphics.lineStyle(10, 0x94ada7).lineBetween(2, -119, 42, -100);
    armGraphics
      .lineStyle(6, 0x93aba6)
      .lineBetween(37, -104, 33, -82)
      .lineBetween(33, -82, 45, -70)
      .lineBetween(46, -98, 58, -83)
      .lineBetween(58, -83, 53, -67);
    this.arm.add(armGraphics);
    this.gauge = scene.add.graphics().setDepth(20);
    this.light = scene.add
      .image(this.x, this.y - 92, 'glow')
      .setTint(this.color)
      .setScale(2.6)
      .setAlpha(0.09)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(17);
    this.sparks = scene.add
      .particles(this.x + 63, this.y - 100, 'spark', {
        lifespan: { min: 200, max: 800 },
        speed: { min: 35, max: 140 },
        angle: { min: 195, max: 345 },
        gravityY: 300,
        scale: { start: 0.38, end: 0 },
        tint: [0xf4d393, 0xabe9d9],
        blendMode: Phaser.BlendModes.ADD,
        emitting: false,
      })
      .setDepth(25);
    this.label = scene.add
      .text(this.x, this.y - 227, 'AUTOMATED', {
        fontFamily: 'Geist Mono, monospace',
        fontSize: '10px',
        color: '#9ebcad',
        backgroundColor: '#15303a',
        padding: { x: 10, y: 7 },
        resolution: TEXT_RESOLUTION,
      })
      .setOrigin(0.5)
      .setDepth(21);
  }

  setWork(active: boolean, failed: boolean): void {
    this.active = active;
    this.label.setText(failed ? 'CHECK FAILED' : active ? 'RUNNING CHECKS' : 'AUTOMATED');
    this.label.setColor(failed ? '#f0a7a1' : active ? '#efd89f' : '#9ebcad');
  }

  tick(time: number): void {
    this.arm.setRotation(this.active ? Math.sin(time * 0.0025) * 0.45 : -0.15);
    this.light.setAlpha(this.active ? 0.17 + Math.sin(time * 0.004) * 0.05 : 0.06);
    this.gauge.clear().fillStyle(0x91d7be);
    for (let i = 0; i < 4; i++) {
      const height = this.active ? 5 + (Math.sin(time * 0.003 + i) + 1) * 6 : 5;
      this.gauge.fillRect(this.x - 47 + i * 8, this.y - 23 - height, 4, height);
    }
    if (this.active && time > this.pulseAt) {
      this.sparks.explode(9);
      this.pulseAt = time + 760;
    }
  }
}

export function addTerminal(scene: Phaser.Scene, index: number, color: number): void {
  const bench = benchAt(index);
  scene.add
    .image(bench.x + 66, bench.y, 'terminal')
    .setOrigin(0.5, 1)
    .setScale(0.78)
    .setDepth(24);
  scene.add
    .image(bench.x + 66, bench.y - 111, 'glow')
    .setTint(color)
    .setScale(1.3)
    .setAlpha(0.13)
    .setBlendMode(Phaser.BlendModes.ADD)
    .setDepth(25);
}
