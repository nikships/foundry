import Phaser from 'phaser';
import type { WorkshopStation } from '../../../view-models/workshop-view.js';
import { benchAt, TEXT_RESOLUTION, type Workbench } from './world-layout.js';

type Pose = 'type' | 'think' | 'stretch' | 'glance' | 'settle';

interface PoseFrame {
  leftArm: number;
  rightArm: number;
  headTilt: number;
  headLift: number;
}

/** Working agents mostly type, punctuated by thought and a look around. */
const WORK_LOOP: Pose[] = ['type', 'type', 'type', 'think', 'type', 'glance'];
const IDLE_LOOP: Pose[] = ['settle', 'glance', 'settle', 'stretch'];

const POSE_SPANS: Record<Pose, [number, number]> = {
  type: [2600, 4200],
  think: [1300, 2100],
  stretch: [1000, 1500],
  glance: [700, 1200],
  settle: [2800, 5200],
};

const GRAVITY = 650;

export class CrewMember {
  readonly zone: Phaser.GameObjects.Zone;
  readonly body: Phaser.Physics.Arcade.Body;
  readonly rig: Phaser.GameObjects.Container;
  readonly bench: Workbench;
  readonly station: WorkshopStation;
  private readonly face: Phaser.GameObjects.Container;
  private readonly torso: Phaser.GameObjects.Image;
  private readonly leftLeg: Phaser.GameObjects.Image;
  private readonly rightLeg: Phaser.GameObjects.Image;
  private readonly leftArm: Phaser.GameObjects.Image;
  private readonly rightArm: Phaser.GameObjects.Image;
  private readonly dust: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly halo: Phaser.GameObjects.Image;
  private readonly shadow: Phaser.GameObjects.Ellipse;
  private readonly bubble: Phaser.GameObjects.Text;
  private readonly badge: Phaser.GameObjects.Text;
  private logo?: Phaser.GameObjects.Image;
  private model: string | null = null;
  private frame: PoseFrame = { leftArm: -0.15, rightArm: 0.15, headTilt: 0, headLift: 0 };
  private pose: Pose = 'settle';
  private poseUntil: number;
  private poseStep = 0;
  private mark: number;
  private active = false;
  private airborne = false;
  private leaping = false;
  private recoverAt = 0;
  private legTime = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    station: WorkshopStation,
    index: number,
    platforms: Phaser.Physics.Arcade.StaticGroup,
  ) {
    this.station = station;
    this.bench = benchAt(index);
    const { x, y } = this.bench;
    const color = Phaser.Display.Color.HexStringToColor(station.color).color;
    this.mark = x - 55;
    this.shadow = scene.add.ellipse(x, y - 1, 58, 10, 0x000711, 0.4).setDepth(16);
    this.zone = scene.add.zone(x - 45, y - 90, 45, 138).setDepth(21);
    scene.physics.add.existing(this.zone);
    this.body = this.zone.body as Phaser.Physics.Arcade.Body;
    // Fall speed also caps the recovery leap, so it must cover the tallest bench.
    this.body.setCollideWorldBounds(true).setBounce(0.08).setMaxVelocity(260, 940);
    scene.physics.add.collider(this.zone, platforms);
    this.rig = scene.add.container(x, y).setDepth(22);
    this.halo = scene.add
      .image(0, 0, 'glow')
      .setTint(color)
      .setAlpha(0.07)
      .setScale(1.7)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.leftLeg = scene.add.image(-12, 41, 'crew-boot').setOrigin(0.5, 0.15).setScale(0.8);
    this.rightLeg = scene.add.image(12, 41, 'crew-boot').setOrigin(0.5, 0.15).setScale(0.8);
    this.torso = scene.add.image(0, 20, 'crew-body').setScale(0.85).setTint(color);
    this.leftArm = scene.add
      .image(-25, 16, 'crew-arm')
      .setOrigin(0.5, 0.15)
      .setScale(0.8)
      .setTint(color);
    this.rightArm = scene.add
      .image(25, 16, 'crew-arm')
      .setOrigin(0.5, 0.15)
      .setScale(0.8)
      .setTint(color);
    this.badge = scene.add
      .text(0, 0, '?', {
        fontFamily: 'Geist Mono, monospace',
        fontSize: '19px',
        color: '#cfe0d8',
        resolution: TEXT_RESOLUTION,
      })
      .setOrigin(0.5);
    this.face = scene.add.container(0, -28, [
      scene.add.image(0, 0, 'crew-head').setScale(0.85),
      this.badge,
    ]);
    this.rig.add([
      this.halo,
      this.leftLeg,
      this.rightLeg,
      this.torso,
      this.leftArm,
      this.rightArm,
      this.face,
    ]);
    this.dust = scene.add
      .particles(0, 0, 'spark', {
        lifespan: { min: 180, max: 420 },
        speed: { min: 20, max: 85 },
        angle: { min: 200, max: 340 },
        scale: { start: 0.5, end: 0 },
        alpha: { start: 0.5, end: 0 },
        tint: [0xcfd8c8, 0x9fb8ae],
        emitting: false,
      })
      .setDepth(20);
    this.bubble = scene.add
      .text(x, y - 179, '', {
        fontFamily: 'Geist Mono, monospace',
        fontSize: '11px',
        color: '#d4e6d7',
        backgroundColor: '#102c35',
        padding: { x: 12, y: 8 },
        wordWrap: { width: 230 },
        resolution: TEXT_RESOLUTION,
      })
      .setOrigin(0.5, 1)
      .setDepth(30)
      .setVisible(false);
    this.zone.setInteractive({ useHandCursor: true });
    this.zone.on('pointerdown', () => this.hop());
    this.poseUntil = 900 + index * 700;
  }

  setModel(model: string | null, textureKey?: string): void {
    if (model === this.model && this.logo) return;
    this.model = model;
    if (!textureKey || !this.scene.textures.exists(textureKey)) return;
    this.logo?.destroy();
    this.badge.setVisible(false);
    this.logo = this.scene.add.image(0, 0, textureKey).setDisplaySize(36, 36);
    this.face.add(this.logo);
  }

  setWork(active: boolean, activity: string): void {
    if (active !== this.active) this.poseUntil = 0;
    this.active = active;
    this.bubble
      .setVisible(active)
      .setText(activity.length > 34 ? `${activity.slice(0, 32)}…` : activity);
    this.halo.setAlpha(active ? 0.2 : 0.06);
  }

  hop(): void {
    if (!this.body.blocked.down) return;
    this.body.setVelocityY(-320);
    this.dust.explode(9, this.zone.x, this.zone.y + 64);
  }

  private choosePose(time: number): void {
    if (time < this.poseUntil) return;
    const loop = this.active ? WORK_LOOP : IDLE_LOOP;
    this.pose = loop[this.poseStep++ % loop.length]!;
    const [min, max] = POSE_SPANS[this.pose];
    this.poseUntil = time + Phaser.Math.Between(min, max);
    // Idle workers drift between two nearby marks, always left of the desk.
    if (!this.active && this.pose === 'settle')
      this.mark = Phaser.Math.Between(this.bench.x - 72, this.bench.x - 34);
  }

  private posture(time: number): PoseFrame {
    switch (this.pose) {
      case 'type': {
        const beat = Math.sin(time * 0.024);
        return {
          leftArm: -1.02 + beat * 0.13,
          rightArm: -0.82 - beat * 0.13,
          headTilt: 0.07,
          headLift: 1.6,
        };
      }
      case 'think':
        return {
          leftArm: -0.15,
          rightArm: -2.1 + Math.sin(time * 0.004) * 0.06,
          headTilt: -0.12,
          headLift: -1.5,
        };
      case 'stretch': {
        const sway = Math.sin(time * 0.005) * 0.08;
        return { leftArm: -2.85 + sway, rightArm: 2.85 + sway, headTilt: sway, headLift: -3 };
      }
      case 'glance':
        return {
          leftArm: -0.12,
          rightArm: 0.12,
          headTilt: Math.sin(time * 0.006) * 0.17,
          headLift: -0.5,
        };
      case 'settle':
        return { leftArm: -0.1, rightArm: 0.1, headTilt: 0, headLift: 0 };
    }
  }

  private applyFrame(time: number, delta: number, stride: number, walking: boolean): void {
    const target = this.posture(time);
    if (walking) {
      target.leftArm = -stride * 0.55;
      target.rightArm = stride * 0.55;
      target.headTilt = 0;
      target.headLift = 0.6;
    }
    const ease = 1 - Math.exp(-delta * 0.011);
    this.frame = {
      leftArm: Phaser.Math.Linear(this.frame.leftArm, target.leftArm, ease),
      rightArm: Phaser.Math.Linear(this.frame.rightArm, target.rightArm, ease),
      headTilt: Phaser.Math.Linear(this.frame.headTilt, target.headTilt, ease),
      headLift: Phaser.Math.Linear(this.frame.headLift, target.headLift, ease),
    };
    this.leftArm.setRotation(this.frame.leftArm);
    this.rightArm.setRotation(this.frame.rightArm);
    const breath = Math.sin(time * 0.0021 + this.bench.x) * 0.9;
    this.face.setY(-28 + this.frame.headLift + breath * 0.55);
    this.face.setRotation(this.frame.headTilt);
    this.torso.setY(20 + breath * 0.3);
  }

  /** A click or a collision may knock a worker off a catwalk. Leap home, never teleport. */
  private recover(time: number): void {
    if (this.leaping) {
      // Solid again only once the feet clear the platform top, so the leap
      // sails up through the deck and then lands on it.
      if (this.zone.y < this.bench.y - 75 && this.body.velocity.y > -40) {
        this.leaping = false;
        this.body.checkCollision.none = false;
      }
      return;
    }
    if (this.zone.y <= this.bench.y + 90 || time < this.recoverAt) return;
    this.recoverAt = time + 1400;
    this.leaping = true;
    this.body.checkCollision.none = true;
    const dy = this.bench.y - 130 - this.zone.y;
    const seconds = Math.max(0.65, Math.sqrt((2 * Math.abs(dy)) / GRAVITY) * 1.05);
    this.body.setVelocity(
      (this.bench.x - 45 - this.zone.x) / seconds,
      (dy - 0.5 * GRAVITY * seconds * seconds) / seconds,
    );
    this.dust.explode(9, this.zone.x, this.zone.y + 64);
  }

  tick(time: number, delta: number): void {
    this.choosePose(time);
    const grounded = this.body.blocked.down;
    const goal = this.active ? this.bench.x - 22 : this.mark;
    const distance = goal - this.zone.x;
    const walking = grounded && Math.abs(distance) > 6;
    if (grounded) this.body.setVelocityX(walking ? Math.sign(distance) * 46 : 0);
    if (this.airborne && grounded) this.dust.explode(7, this.zone.x, this.zone.y + 64);
    this.airborne = !grounded;
    this.legTime += walking ? delta * 0.014 : 0;
    const stride = walking ? Math.sin(this.legTime) * 0.55 : 0;
    const legEase = 1 - Math.exp(-delta * 0.02);
    this.leftLeg.setRotation(
      Phaser.Math.Linear(this.leftLeg.rotation, grounded ? stride : 0.24, legEase),
    );
    this.rightLeg.setRotation(
      Phaser.Math.Linear(this.rightLeg.rotation, grounded ? -stride : -0.3, legEase),
    );
    this.applyFrame(time, delta, stride, walking);
    this.rig.setPosition(this.zone.x, this.zone.y);
    this.shadow
      .setPosition(this.zone.x, this.bench.y - 1)
      .setAlpha(Math.max(0.08, 0.35 - (this.bench.y - this.zone.y - 70) * 0.001));
    this.bubble.setPosition(this.zone.x, this.zone.y - 95);
    this.recover(time);
  }
}
