import Phaser from 'phaser';
import type { WorkshopGameHandle, WorkshopGameState } from './game-types.js';
import { createGameTextures } from './textures.js';
import { buildEnvironment } from './environment.js';
import { CrewMember } from './crew.js';
import { addTerminal, WorkMachine } from './machinery.js';
import { benchAt, deliveryVelocity, GROUND_Y, WORLD_HEIGHT, worldWidth } from './world-layout.js';

type LogoLoader = (model: string) => Promise<HTMLImageElement | null>;

class FactoryWorld extends Phaser.Scene {
  private state: WorkshopGameState;
  private crew = new Map<string, CrewMember>();
  private machines = new Map<string, WorkMachine>();
  private platforms?: Phaser.Physics.Arcade.StaticGroup;
  private background?: Phaser.GameObjects.Image;
  private packages: Phaser.Physics.Arcade.Image[] = [];
  private layout = '';
  private currentId?: string;
  private following = true;
  private cameraPhase?: string;
  private zoomFactor = 1;
  private dragged = false;
  private readonly pendingLogos = new Set<string>();
  private readonly boundsRect = new Phaser.Geom.Rectangle();
  ready = false;

  constructor(
    initial: WorkshopGameState,
    private readonly loadLogo: LogoLoader,
    private readonly backdrop: HTMLImageElement | null,
  ) {
    super('factory-world');
    this.state = initial;
  }

  create(): void {
    createGameTextures(this);
    if (this.backdrop) {
      this.textures.addImage('observatory', this.backdrop);
      this.background = this.add.image(0, 0, 'observatory').setOrigin(0).setDepth(-100);
    }
    this.cameras.main.setBackgroundColor('#081725');
    this.physics.world.setBounds(
      0,
      -200,
      worldWidth(this.state.stations.length),
      WORLD_HEIGHT + 200,
    );
    this.configureInput();
    this.ready = true;
    this.sync(this.state);
    this.fit();
    this.scale.on('resize', this.fit, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.fit, this));
  }

  private configureInput(): void {
    this.input.on('pointerdown', () => {
      this.dragged = false;
    });
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!pointer.isDown) return;
      const dx = pointer.x - pointer.prevPosition.x;
      const dy = pointer.y - pointer.prevPosition.y;
      if (Math.abs(dx) + Math.abs(dy) < 2 && !this.dragged) return;
      this.dragged = true;
      this.following = false;
      this.cameras.main.scrollX -= dx / this.cameras.main.zoom;
      this.cameras.main.scrollY -= dy / this.cameras.main.zoom;
    });
    this.input.on(
      'wheel',
      (
        _pointer: Phaser.Input.Pointer,
        _over: Phaser.GameObjects.GameObject[],
        _dx: number,
        dy: number,
      ) => this.zoomBy(dy < 0 ? 1 : -1),
    );
  }

  private rebuild(): void {
    for (const collider of this.physics.world.colliders.getActive()) collider.destroy();
    this.children
      .getChildren()
      .filter((child) => child !== this.background)
      .forEach((child) => child.destroy());
    this.tweens.killAll();
    this.platforms?.destroy();
    this.crew.clear();
    this.machines.clear();
    this.packages = [];
    this.platforms = buildEnvironment(this, this.state.stations);
    this.state.stations.forEach((station, index) => {
      const id = station.phase.phaseId;
      if (station.phase.kind === 'agent') {
        this.crew.set(id, new CrewMember(this, station, index, this.platforms!));
        addTerminal(this, index, Phaser.Display.Color.HexStringToColor(station.color).color);
      } else this.machines.set(id, new WorkMachine(this, station, index));
    });
    this.physics.world.setBounds(
      0,
      -200,
      worldWidth(this.state.stations.length),
      WORLD_HEIGHT + 200,
    );
    this.cameras.main.setBounds(0, 0, worldWidth(this.state.stations.length), WORLD_HEIGHT);
  }

  sync(state: WorkshopGameState): void {
    this.state = state;
    if (!this.ready) return;
    const layout = state.stations.map((station) => station.phase.phaseId).join(':');
    if (layout !== this.layout) {
      this.layout = layout;
      this.rebuild();
      this.fit();
    }
    const changed = this.currentId && state.activeId && this.currentId !== state.activeId;
    if (changed && state.live && !state.paused) this.deliver(this.currentId!, state.activeId!);
    if (state.activeId !== this.currentId && this.following) this.cameraPhase = state.activeId;
    this.currentId = state.activeId;
    for (const station of state.stations) {
      const active =
        state.live &&
        station.phase.phaseId === state.activeId &&
        station.phase.status === 'running';
      this.crew.get(station.phase.phaseId)?.setWork(active, state.activity);
      this.machines.get(station.phase.phaseId)?.setWork(active, station.phase.status === 'fail');
      if (station.model) this.ensureLogo(station.phase.phaseId, station.model);
    }
    if (state.paused) this.physics.world.pause();
    else this.physics.world.resume();
    this.tweens.timeScale = state.paused ? 0 : 1;
    this.children.getChildren().forEach((child) => {
      if (child instanceof Phaser.GameObjects.Particles.ParticleEmitter)
        child.timeScale = state.paused ? 0 : 1;
    });
  }

  private ensureLogo(phaseId: string, model: string): void {
    const key = `model:${model}`;
    if (this.textures.exists(key)) {
      this.crew.get(phaseId)?.setModel(model, key);
      return;
    }
    if (this.pendingLogos.has(model)) return;
    this.pendingLogos.add(model);
    void this.loadLogo(model)
      .then((image) => {
        if (!this.sys.isActive() || !image) return;
        if (!this.textures.exists(key)) this.textures.addImage(key, image);
        for (const station of this.state.stations) {
          if (station.model === model) this.crew.get(station.phase.phaseId)?.setModel(model, key);
        }
      })
      .catch(() => {
        // Unknown logos remain a neutral badge; a missing brand never breaks the world.
      });
  }

  private deliver(fromId: string, toId: string): void {
    const fromIndex = this.state.stations.findIndex((station) => station.phase.phaseId === fromId);
    const toIndex = this.state.stations.findIndex((station) => station.phase.phaseId === toId);
    if (fromIndex < 0 || toIndex < 0 || !this.platforms) return;
    const from = benchAt(fromIndex);
    const to = benchAt(toIndex);
    const sender = this.crew.get(fromId);
    const origin = sender
      ? { x: sender.zone.x + 35, y: sender.zone.y }
      : { x: from.x, y: from.y - 160 };
    const parcel = this.physics.add.image(origin.x, origin.y, 'parcel').setDepth(28);
    parcel.setCircle(20, 7, 7).setBounce(0.48).setDragX(80).setAngularVelocity(130);
    const velocity = deliveryVelocity(origin, { x: to.x - 60, y: to.y - 45 });
    parcel.setVelocity(velocity.x, velocity.y);
    this.physics.add.collider(parcel, this.platforms);
    this.packages.push(parcel);
    sender?.hop();
    this.time.delayedCall(6000, () => {
      this.packages = this.packages.filter((item) => item !== parcel);
      if (parcel.active)
        this.tweens.add({
          targets: parcel,
          alpha: 0,
          duration: 450,
          onComplete: () => parcel.destroy(),
        });
    });
  }

  focus(phaseId?: string): void {
    this.following = true;
    this.cameraPhase = phaseId ?? this.state.activeId;
  }

  zoomBy(direction: number): void {
    this.zoomFactor = Phaser.Math.Clamp(this.zoomFactor * (direction > 0 ? 1.12 : 0.89), 0.6, 1.8);
    this.fit();
  }

  /**
   * The painting lives in world space and is re-laid out every frame: it is
   * sized to cover the camera's visible rect with headroom, and its travel is
   * the camera's scroll progress mapped onto the leftover width. Both edges
   * of the picture therefore land exactly at both ends of the scroll range,
   * so no camera position can slide past it, and the remainder moves slower
   * than the world, which reads as distance.
   */
  private layoutBackdrop(): void {
    if (!this.background) return;
    const camera = this.cameras.main;
    // Derive the visible rect from live scroll/zoom; worldView lags a frame.
    const viewWidth = camera.width / camera.zoom;
    const viewHeight = camera.height / camera.zoom;
    if (viewWidth <= 0 || viewHeight <= 0) return;
    const viewX = camera.scrollX + (camera.width - viewWidth) / 2;
    const viewY = camera.scrollY + (camera.height - viewHeight) / 2;
    const source = this.textures.get('observatory').getSourceImage();
    const scale = Math.max(viewWidth / source.width, viewHeight / source.height) * 1.22;
    const displayWidth = source.width * scale;
    const displayHeight = source.height * scale;
    this.background.setDisplaySize(displayWidth, displayHeight);
    const bounds = camera.getBounds(this.boundsRect);
    const progress = (limit: number, position: number): number =>
      limit > 0 ? Phaser.Math.Clamp(position / limit, 0, 1) : 0.5;
    const tx = progress(bounds.width - viewWidth, viewX - bounds.x);
    const ty = progress(bounds.height - viewHeight, viewY - bounds.y);
    this.background.setPosition(
      viewX - tx * (displayWidth - viewWidth),
      viewY - ty * (displayHeight - viewHeight),
    );
  }

  private fit(): void {
    if (!this.ready) return;
    const { width, height } = this.scale;
    const zoom = Math.min(height / 1030, width / 1200) * this.zoomFactor;
    // Never let the view outgrow the world's height: the stage would float.
    this.cameras.main.setZoom(Math.max(height / WORLD_HEIGHT, 0.38, zoom));
    const point = benchAt(
      Math.max(
        0,
        this.state.stations.findIndex((station) => station.phase.phaseId === this.state.activeId),
      ),
    );
    this.cameras.main.centerOn(point.x + 260, 540);
  }

  update(time: number, delta: number): void {
    if (!this.ready) return;
    if (!this.state.paused) {
      for (const member of this.crew.values()) member.tick(time, Math.min(delta, 50));
      for (const machine of this.machines.values()) machine.tick(time);
    }
    if (this.following) {
      const index = this.state.stations.findIndex(
        (station) => station.phase.phaseId === this.cameraPhase,
      );
      const bench = benchAt(Math.max(0, index));
      const camera = this.cameras.main;
      const target = bench.x + 200 - camera.width / (2 * camera.zoom);
      camera.scrollX = Phaser.Math.Linear(camera.scrollX, target, this.state.paused ? 1 : 0.025);
    }
    this.layoutBackdrop();
    // Bound the parcel pool, even across rapid retries.
    while (this.packages.length > 8) this.packages.shift()?.destroy();
    for (const parcel of this.packages) if (parcel.y > GROUND_Y + 80) parcel.destroy();
  }
}

export function createWorkshopGame(
  host: HTMLElement,
  initial: WorkshopGameState,
  loadLogo: LogoLoader,
  backdrop: HTMLImageElement | null,
): WorkshopGameHandle {
  const scene = new FactoryWorld(initial, loadLogo, backdrop);
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: host,
    backgroundColor: '#081725',
    transparent: false,
    width: host.clientWidth,
    height: host.clientHeight,
    scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH },
    render: { antialias: true, roundPixels: false, powerPreference: 'low-power' },
    physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 650 }, debug: false } },
    input: { keyboard: false },
    audio: { noAudio: true },
    fps: { target: 60, forceSetTimeOut: false },
    scene: [scene],
    banner: false,
  });
  return {
    update: (state) => scene.sync(state),
    focus: (phaseId) => scene.focus(phaseId),
    zoom: (direction) => scene.zoomBy(direction),
    destroy: () => game.destroy(true),
  };
}
