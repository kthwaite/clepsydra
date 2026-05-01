/* ASCII figures used as decorative engravings in the codex aesthetic. */

export const ASCII_HERMES = String.raw`
              .--..--.
            .'        '.
           /  .-.  .-.  \
          |  /   \/   \  |
          |  \  o /\ o /  |
           \  '-'  '-'  /
            '.   __   .'
              | (__) |
        .-----'  ||  '-----.
       /  ___    ||    ___  \
      |  /   \   ||   /   \  |
      |  | o |---||---| o |  |
       \  \_/    ||    \_/  /
        '----.   ||   .----'
              \  ||  /
               \ || /
                \||/
                 ||
                _||_
               '----'`;

export const ASCII_COMPASS = String.raw`
               . N .
            .--+----+--.
         .--      |      --.
       .'    .   N|N    .    '.
      /   .'  .   |   .  '.   \
     | W ----+--- + ---+---- E |
      \   '.  '.  |  .'  .'   /
       '.    '   S|S   '    .'
         '--      |      --'
            '--+----+--'
               . S .`;

export const ASCII_KEY = String.raw`
   .---.
  /  o  \------------=#
  \  o  /------------+
   '---'`;

export const ASCII_HAND = String.raw`
        .---.
       /     \
      |  | |  |
      |  | |  |
   ___|  | |  |___
  /   |  | |  |   \
 |    |  '-'  |    |
 |    |       |    |
  \   |       |   /
   \__|_______|__/`;

export const ASCII_EYE = String.raw`
        ___________
      /             \
     /   .-------.   \
    |   /  .---.  \   |
    |  |  |  ◉  |  |  |
    |   \  '---'  /   |
     \   '-------'   /
      \_____________/`;

export const ASCII_GLOBE = String.raw`
        _.--""--._
      .'  ___ ___ '.
     / .-/   |   \-. \
    | / /    |    \ \ |
    ||/__----+----__\||
    | \ \    |    / / |
     \ '-\___|___/-' /
      '.   \ | /   .'
        '--._|_.--'`;

export const ASCII_KEYHOLE = String.raw`
     .---.
    /     \
   |   o   |
   |   |   |
    \  |  /
     \_|_/`;

export const ASCII_QUILL = String.raw`
                  .'/
                .' /
              .'  /
            .'  .'
          .'  .'
        .'  .'         ___
      .'  .'          /  /
    .'  .'           /  /
  .'  .'            /  /
 ' .'              /  /
  '                '--'`;

const DEFAULT_FRONTISPIECE_TEXT = `
clepsydra private codex water-clock marginalia orbit folios indexed
reader enter the atrium follow blue ink through cross-references and tags
morning pages lunar tables garden paths backlinks concordance glosses
memory condenses into maps constellations notebooks drafts and diurnals
open the folio resume the thread inscribe what must not evaporate
`.trim();

export type MiniAsciiAnimationOptions = {
  cols?: number;
  rows?: number;
  background?: string;
  textColor?: string;
  fontFamily?: string;
  speed?: number;
  swirlStrength?: number;
  spiralArms?: number;
  armCurl?: number;
  armWidth?: number;
  initialRampMs?: number;
  spiralTransitionMs?: number;
  spiralHoldMs?: number;
  solidHoldMs?: number;
  text?: string;
};

const { sin, cos, round, sqrt, max, floor, atan2, PI } = Math;

function makeGrid(text: string, rows: number, cols: number) {
  const normalized = `${text.replace(/\s+/g, " ").trim()} `;
  const grid: string[] = [];

  for (let y = 0; y < rows; y++) {
    let line = "";

    for (let x = 0; x < cols; x++) {
      line += normalized[(y * cols + x) % normalized.length];
    }

    grid.push(line);
  }

  return grid;
}

export class MiniAsciiAnimation {
  private readonly canvas: HTMLCanvasElement;
  private readonly cols: number;
  private readonly rows: number;
  private readonly background: string;
  private readonly textColor: string;
  private readonly fontFamily: string;
  private readonly speed: number;
  private readonly swirlStrength: number;
  private readonly spiralArms: number;
  private readonly armCurl: number;
  private readonly armWidth: number;
  private readonly initialRampMs: number;
  private readonly spiralTransitionMs: number;
  private readonly spiralHoldMs: number;
  private readonly solidHoldMs: number;
  private readonly source: string[];
  private startTime = 0;
  private frameId = 0;
  private running = false;

  constructor(canvas: HTMLCanvasElement, options: MiniAsciiAnimationOptions = {}) {
    this.canvas = canvas;
    this.cols = options.cols ?? 30;
    this.rows = options.rows ?? 30;
    this.background = options.background ?? "#061434";
    this.textColor = options.textColor ?? "hsl(220, 48%, 58%)";
    this.fontFamily = options.fontFamily ?? "monospace";
    this.speed = options.speed ?? 1;
    this.swirlStrength = options.swirlStrength ?? 5.5;
    this.spiralArms = options.spiralArms ?? 3;
    this.armCurl = options.armCurl ?? 2.25;
    this.armWidth = options.armWidth ?? 0.42;
    this.initialRampMs = options.initialRampMs ?? 5000;
    this.spiralTransitionMs = options.spiralTransitionMs ?? 6500;
    this.spiralHoldMs = options.spiralHoldMs ?? 4200;
    this.solidHoldMs = options.solidHoldMs ?? 1800;
    this.source = makeGrid(
      options.text ?? DEFAULT_FRONTISPIECE_TEXT,
      this.rows,
      this.cols,
    );
  }

  start() {
    if (this.running) {
      return;
    }

    this.running = true;
    this.startTime = performance.now();
    this.frameId = requestAnimationFrame((time) => this.render(time));
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.frameId);
  }

  restart() {
    this.startTime = performance.now();
  }

  private render(now: number) {
    if (!this.running) {
      return;
    }

    const ctx = this.canvas.getContext("2d");

    if (!ctx) {
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = max(1, round(rect.width * dpr));
    const height = max(1, round(rect.height * dpr));
    const cellW = width / this.cols;
    const cellH = height / this.rows;
    const fontSize = max(1, floor(Math.min(cellW * 1.25, cellH * 1.1)));
    const rawElapsed = now - this.startTime;
    const ramp = Math.min(1, rawElapsed / this.initialRampMs);
    const easedRamp = ramp * ramp * (3 - 2 * ramp);
    const elapsed = rawElapsed * this.speed;
    const time = elapsed * 0.001 * (0.18 + easedRamp * 0.82);
    const cycleLength =
      this.solidHoldMs +
      this.spiralTransitionMs +
      this.spiralHoldMs +
      this.spiralTransitionMs;
    const cycleElapsed = rawElapsed % cycleLength;
    let spiralProgress: number;

    if (cycleElapsed < this.solidHoldMs) {
      spiralProgress = 0;
    } else if (cycleElapsed < this.solidHoldMs + this.spiralTransitionMs) {
      const t = (cycleElapsed - this.solidHoldMs) / this.spiralTransitionMs;
      spiralProgress = smoothstep(t);
    } else if (
      cycleElapsed <
      this.solidHoldMs + this.spiralTransitionMs + this.spiralHoldMs
    ) {
      spiralProgress = 1;
    } else {
      const t =
        (cycleElapsed -
          this.solidHoldMs -
          this.spiralTransitionMs -
          this.spiralHoldMs) /
        this.spiralTransitionMs;
      spiralProgress = 1 - smoothstep(t);
    }

    this.canvas.width = width;
    this.canvas.height = height;

    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, width, height);
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.font = `${fontSize}px ${this.fontFamily}`;

    for (let y = 0; y < this.rows; y++) {
      const normalizedY = 1 - (y * 2) / this.rows;

      for (let x = 0; x < this.cols; x++) {
        const normalizedX = (x * 2) / this.cols - 1;
        const radius = sqrt(normalizedX * normalizedX + normalizedY * normalizedY);
        const theta = atan2(normalizedY, normalizedX);
        const phaseRaw =
          (theta / (2 * PI)) * this.spiralArms +
          radius * this.armCurl -
          time * 0.18;
        const phase = phaseRaw - floor(phaseRaw);
        const armDistance = Math.abs(phase - 0.5) * 2;
        const activeArmWidth =
          this.armWidth + (1 - this.armWidth) * (1 - spiralProgress);

        if (armDistance > activeArmWidth) {
          continue;
        }

        const coreTwist = this.swirlStrength / max(0.16, radius);
        const radialTwist = radius * 7.5;
        const pulse = sin(time * 1.2 + radius * 11.0) * 0.65;
        const angle =
          theta +
          (coreTwist + radialTwist + pulse + time * 0.75) * spiralProgress;
        const spiralRadius =
          radius +
          sin(theta * this.spiralArms + radius * 8.0 - time * 1.6) *
            0.06 *
            spiralProgress;
        const warpedX = cos(angle) * spiralRadius;
        const warpedY = sin(angle) * spiralRadius;
        const spiralSampleX = floor(((warpedX + 1) / 2) * this.cols);
        const spiralSampleY = floor(((warpedY + 1) / 2) * this.rows) % this.rows;
        const sampleX = floor(
          x * (1 - spiralProgress) + spiralSampleX * spiralProgress,
        );
        const sampleY = floor(
          y * (1 - spiralProgress) + spiralSampleY * spiralProgress,
        );
        const ch =
          sampleX < 0 ||
          sampleX >= this.cols ||
          sampleY < 0 ||
          sampleY >= this.rows
            ? " "
            : (this.source[sampleY]?.[sampleX] ?? " ");
        const armAlpha = max(0.25, 0.35 + (1 - armDistance / this.armWidth) * 0.65);

        ctx.globalAlpha = 1 * (1 - spiralProgress) + armAlpha * spiralProgress;
        ctx.fillStyle = this.textColor;
        ctx.fillText(ch, x * cellW + cellW / 2, y * cellH + cellH / 2);
        ctx.globalAlpha = 1;
      }
    }

    this.frameId = requestAnimationFrame((time) => this.render(time));
  }
}

function smoothstep(t: number) {
  return t * t * (3 - 2 * t);
}
