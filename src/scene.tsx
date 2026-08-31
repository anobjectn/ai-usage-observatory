import { createContext, useContext, useEffect, useRef } from "react";
import type { ProviderHeadroom } from "./quota-headroom";

function TelescopeIcon() {
  return <svg viewBox="0 0 512.001 512.001" fill="currentColor" aria-hidden="true">
    <path d="M511.441,82.002c0-4.456-1.735-8.646-4.887-11.797L441.235,4.887C438.085,1.735,433.895,0,429.439,0 c-4.456,0-8.646,1.735-11.797,4.887L222.781,199.747l-23.944-23.944l46.875-46.875c3.153-3.153,3.153-8.264,0-11.416l-48.71-48.71 c-3.153-3.153-8.264-3.153-11.416,0l-46.875,46.875l-32.81-32.811c1.071-0.842,2.104-1.745,3.083-2.723 c3.153-3.153,3.153-8.264,0-11.416L72.452,32.195c-3.153-3.153-8.264-3.153-11.416,0c-13.22,13.22-13.22,34.729,0,47.948 c6.403,6.404,14.918,9.931,23.974,9.931c1.66,0,3.3-0.121,4.914-0.354l37.372,37.372L2.925,251.463 c-3.153,3.153-3.153,8.264,0,11.416l48.71,48.71c1.576,1.576,3.642,2.365,5.708,2.365s4.132-0.788,5.708-2.365l85.623-85.623 l15.334,15.334l-7.114,7.114c-0.002,0.002-0.003,0.003-0.005,0.005s-0.003,0.003-0.005,0.005L7.894,397.413 c-6.504,6.504-6.504,17.088,0,23.593l82.541,82.541c3.15,3.151,7.341,4.887,11.797,4.887s8.646-1.735,11.797-4.887 l156.112-156.112l16.453,16.453l-85.623,85.623c-3.153,3.153-3.153,8.264,0,11.416l48.71,48.71 c1.576,1.576,3.642,2.365,5.708,2.365c2.065,0,4.132-0.788,5.708-2.365l124.371-124.371l36.268,36.268 c-1.481,10.232,1.705,21.016,9.561,28.872c6.403,6.404,14.918,9.931,23.974,9.931c9.056,0,17.571-3.527,23.974-9.931 c3.153-3.153,3.153-8.264,0-11.416l-36.532-36.532c-3.153-3.153-8.264-3.153-11.416,0c-0.983,0.983-1.884,2.017-2.721,3.085 l-31.693-31.693l46.875-46.875c3.153-3.153,3.153-8.264,0-11.416l-48.71-48.71c-3.153-3.153-8.264-3.153-11.416,0l-46.875,46.875 l-25.064-25.064L506.556,93.8C509.707,90.648,511.441,86.458,511.441,82.002z M85.01,73.931 c-4.743-0.001-9.203-1.848-12.558-5.203c-3.354-3.355-5.202-7.814-5.202-12.558c0-1.89,0.293-3.736,0.859-5.484l22.386,22.386 C88.746,73.637,86.901,73.931,85.01,73.931z M438.37,420.947l22.386,22.385c-1.749,0.565-3.594,0.859-5.485,0.859 c-4.743,0-9.204-1.847-12.558-5.202c-3.354-3.355-5.202-7.814-5.202-12.558C437.511,424.541,437.804,422.695,438.37,420.947z M191.293,85.926l37.293,37.293l-41.166,41.166l-37.293-37.293L191.293,85.926z M57.342,294.465l-37.293-37.293L138.712,138.51 l37.293,37.293L57.342,294.465z M160.089,214.55l27.333-27.333l23.944,23.944l-9.942,9.942c-2.467-1.391-5.257-2.143-8.167-2.143 c-4.457,0-8.646,1.735-11.797,4.887l-6.036,6.036L160.089,214.55z M102.612,492.131c-0.21,0.209-0.551,0.209-0.761,0 l-82.541-82.54c-0.039-0.039-0.157-0.157-0.157-0.381s0.118-0.341,0.157-0.381l100.143-100.143l83.302,83.302L102.612,492.131z M214.171,380.572l-83.302-83.302l31.727-31.727l83.302,83.302L214.171,380.572z M276.177,318.564l-18.863,18.864l-83.302-83.302 l18.864-18.864c0.039-0.039,0.157-0.157,0.38-0.157c0.223,0,0.341,0.118,0.38,0.157l82.541,82.54 C276.387,318.012,276.387,318.355,276.177,318.564z M389.34,283.973l37.293,37.293l-41.166,41.166l-37.293-37.293L389.34,283.973z M374.051,373.85L255.389,492.512l-37.293-37.293l118.662-118.662L374.051,373.85z M325.341,325.139l-27.333,27.333 l-16.453-16.453l6.037-6.037c5.399-5.4,6.301-13.604,2.736-19.959l9.948-9.948L325.341,325.139z M294.856,282.664 c-0.1,0.09-0.205,0.175-0.301,0.272c-0.097,0.097-0.182,0.201-0.272,0.301l-14.919,14.92l-66.081-66.08l14.786-14.786 c0.15-0.129,0.3-0.257,0.442-0.4c0.142-0.142,0.271-0.293,0.4-0.442L403.606,41.753l66.081,66.081L294.856,282.664z M495.138,82.383l-14.035,14.035l-66.081-66.081l14.035-14.035c0.04-0.039,0.158-0.157,0.381-0.157 c0.223,0,0.341,0.118,0.381,0.157l65.32,65.32c0.039,0.039,0.157,0.157,0.157,0.381S495.177,82.343,495.138,82.383z" />
    <path d="M301.681,244.203l-34.443-34.443c-3.153-3.153-8.264-3.153-11.416,0c-3.153,3.153-3.153,8.264,0,11.416l34.443,34.443 c1.576,1.576,3.642,2.365,5.708,2.365c2.065,0,4.132-0.788,5.708-2.365C304.834,252.467,304.834,247.356,301.681,244.203z" />
    <path d="M133.772,188.234l-7.024-7.024c-3.153-3.153-8.264-3.153-11.416,0c-3.153,3.153-3.153,8.264,0,11.416l7.024,7.024 c1.576,1.576,3.642,2.365,5.708,2.365c2.065,0,4.132-0.788,5.708-2.365C136.925,196.498,136.925,191.386,133.772,188.234z" />
    <path d="M331.639,386.101l-7.024-7.024c-3.153-3.153-8.264-3.153-11.416,0c-3.153,3.153-3.153,8.264,0,11.416l7.024,7.024 c1.576,1.576,3.642,2.365,5.708,2.365c2.065,0,4.132-0.788,5.708-2.365C334.792,394.365,334.792,389.253,331.639,386.101z" />
  </svg>;
}

export type SceneEffects = { starfield: boolean; parallax: boolean; twinkle: boolean; tesseract: boolean; speed: number; starDensity: number };
export type ProviderColors = { anthropic: string; openai: string; warp: string };

const STAR_DENSITY_MULTIPLIERS = [0, 0.2, 0.42, 0.68, 1, 1.65, 4.95];
const MAX_STAR_DENSITY = STAR_DENSITY_MULTIPLIERS.length - 1;

// One shared "camera" orbits the hero object. The starfield reads the same
// orientation, so dragging the object pans the whole sky behind the content.
const camera = { yaw: -0.6, pitch: 0.18, vyaw: 0, vpitch: 0, dragging: false, lastInput: 0, version: 0 };
const AUTO_YAW = 0.07;
const DRAG = 0.0085;
const AQUA = "#58d9cf";
let clock = 0;
let lastStep = -1;

// Advances shared time + camera inertia/auto-rotation. Both canvases call this
// each frame; the `lastStep` guard makes only the first caller step the clock.
// `speed` scales ambient motion (auto-rotate, orbit sweep, twinkle) only —
// a user's drag rotation is never scaled, so dragging always feels 1:1.
function stepScene(now: number, animate: boolean, speed: number) {
  if (now === lastStep) return;
  const dt = lastStep < 0 ? 0 : Math.min((now - lastStep) / 1000, 0.1);
  lastStep = now;
  if (!animate || !dt) return;
  clock += dt * speed;
  if (camera.dragging) return;
  const idle = now - camera.lastInput > 2600;
  const pull = Math.min(1, dt * (idle ? 0.5 : 1.6));
  const targetYaw = idle ? AUTO_YAW * speed : 0;
  camera.vyaw += (targetYaw - camera.vyaw) * pull;
  camera.vpitch -= camera.vpitch * pull;
  // When the camera is only decaying toward rest (target zero — dragged to a stop, or speed 0),
  // snap it there once the motion is invisible so the version stops changing and the canvases
  // stop repainting a static scene. Never snap while auto-rotation is pulling away from rest.
  if (targetYaw === 0 && Math.abs(camera.vyaw) < 0.0005 && Math.abs(camera.vpitch) < 0.0005) {
    camera.vyaw = 0;
    camera.vpitch = 0;
    return;
  }
  camera.yaw += camera.vyaw * dt;
  camera.pitch += camera.vpitch * dt;
  camera.version++;
}

function useReducedMotionRef() {
  const ref = useRef(false);
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => { ref.current = query.matches; };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return ref;
}

function channel(hex: string, index: number) { return parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16); }
function mixHex(from: string, to: string, t: number) {
  return `#${[0, 1, 2].map(i => Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * t).toString(16).padStart(2, "0")).join("")}`;
}
// Computed styles come back as "rgb(r, g, b)"; the mixers below index into hex
// digits, so anything read off the DOM has to be normalized first.
function toHex(color: string) {
  if (color.startsWith("#")) return color;
  const parts = color.match(/\d+(\.\d+)?/g);
  if (!parts || parts.length < 3) return "#7de3c8";
  return `#${parts.slice(0, 3).map(part => Math.round(Number(part)).toString(16).padStart(2, "0")).join("")}`;
}
function rgba(hex: string, alpha: number) { return `rgba(${channel(hex, 0)},${channel(hex, 1)},${channel(hex, 2)},${alpha})`; }

function mulberry32(seed: number) {
  return () => {
    seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

type Star = { x: number; y: number; z: number; radius: number; size: number; base: number; tint: number; phase: number; speed: number };

function makeStars(count: number): Star[] {
  const rand = mulberry32(20260718);
  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    // Keep a small reserve in the lower sky so the field remains present
    // behind the content's footer instead of concentrating visually overhead.
    const u = i % 3 === 0 ? -0.98 + rand() * 0.78 : rand() * 2 - 1;
    const azimuth = rand() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const radius = 9 + 51 * Math.pow(rand(), 0.6);
    const near = 1 - (radius - 9) / 51;
    stars.push({
      x: s * Math.cos(azimuth), y: u, z: s * Math.sin(azimuth), radius,
      size: 0.5 + rand() * 1.1 + near * 0.9,
      base: 0.2 + rand() * 0.5 + near * 0.3,
      tint: rand(), phase: rand() * Math.PI * 2, speed: 0.5 + rand() * 1.4,
    });
  }
  return stars;
}

function fitCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

export function Starfield({ accent, effects }: { accent: string; effects: SceneEffects }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef({ accent, effects });
  const dirtyRef = useRef(true);
  const reduced = useReducedMotionRef();
  useEffect(() => { propsRef.current = { accent, effects }; dirtyRef.current = true; }, [accent, effects]);
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let w = 0, h = 0, raf = 0, drawnVersion = -1, drawnClock = -1, baseStarCount = 0;
    let stars: Star[] = [];
    // makeStars is seeded, so growing or shrinking the count regenerates the same field up to
    // the new length — visible stars never shuffle, and memory tracks the chosen density
    // instead of always holding the maximum.
    const syncStars = () => {
      const density = Math.min(MAX_STAR_DENSITY, Math.max(1, Math.round(propsRef.current.effects.starDensity)));
      const target = Math.min(30000, Math.round(baseStarCount * STAR_DENSITY_MULTIPLIERS[density]));
      if (target !== stars.length) {
        stars = makeStars(target);
        dirtyRef.current = true;
      }
    };
    const resize = () => {
      ({ w, h } = fitCanvas(canvas, ctx));
      // Stars fill the whole sky sphere but the camera only sees a narrow cone,
      // so scale the on-screen density target by the visible solid-angle share.
      const f = h * 0.8;
      const coverage = Math.atan(w / 2 / f) * Math.atan(h / 2 / f) / Math.PI;
      baseStarCount = Math.min(6000, Math.round(w * h / 3200 / Math.max(0.02, coverage)));
      syncStars();
      dirtyRef.current = true;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const animate = !reduced.current;
      stepScene(now, animate, propsRef.current.effects.speed);
      syncStars();
      // Repaint only when something can have changed: a prop/resize invalidation, camera
      // motion, or ambient time advancing (twinkle). At speed 0 with a settled camera this
      // skips every frame.
      if (!dirtyRef.current && camera.version === drawnVersion && clock === drawnClock) return;
      drawnVersion = camera.version;
      drawnClock = clock;
      dirtyRef.current = false;
      const { accent, effects } = propsRef.current;
      ctx.clearRect(0, 0, w, h);
      const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
      const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
      const f = h * 0.8, midX = w / 2, midY = h / 2, D = 2.5;
      const density = Math.min(MAX_STAR_DENSITY, Math.max(1, Math.round(effects.starDensity)));
      const visibleStarCount = stars.length;
      for (let index = 0; index < visibleStarCount; index++) {
        const star = stars[index];
        const r = effects.parallax ? density === MAX_STAR_DENSITY ? 4 + (star.radius - 9) * 2.2 : star.radius : 30;
        const wx = star.x * r, wy = star.y * r, wz = star.z * r;
        const rx = wx * cy + wz * sy, rz = wz * cy - wx * sy;
        const ry = wy * cp - rz * sp;
        const depth = D - (wy * sp + rz * cp);
        if (depth < 1.2) continue;
        const sx = midX + rx / depth * f, syp = midY - ry / depth * f;
        if (sx < -4 || sx > w + 4 || syp < -4 || syp > h + 4) continue;
        let alpha = star.base;
        if (effects.twinkle && animate) alpha *= 0.68 + 0.32 * Math.sin(clock * star.speed + star.phase);
        const color = effects.twinkle
          ? star.tint < 0.1 ? accent : star.tint < 0.18 ? AQUA : star.tint < 0.28 ? "#ffe3c2" : "#e2ece7"
          : "#dfe9e4";
        ctx.fillStyle = rgba(color, Math.min(1, alpha));
        const size = star.size;
        if (size < 1.2) ctx.fillRect(sx, syp, size, size);
        else { ctx.beginPath(); ctx.arc(sx, syp, size / 2, 0, Math.PI * 2); ctx.fill(); }
        if (star.base > 0.85 && size > 1.6) {
          ctx.fillStyle = rgba(color, Math.min(1, alpha) * 0.16);
          ctx.beginPath(); ctx.arc(sx, syp, size * 2.2, 0, Math.PI * 2); ctx.fill();
        }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); observer.disconnect(); };
  }, []);
  return <div className="starfield" aria-hidden="true"><canvas ref={canvasRef} /></div>;
}

type Dot = { x: number; y: number; size: number; color: string; alpha: number; hollow?: boolean };
type Seg = { ax: number; ay: number; bx: number; by: number; color: string; alpha: number };

// 16 vertices of the unit tesseract; edges connect vertex pairs whose indices
// differ in exactly one bit (one axis), giving the 32 hypercube edges.
const TESSERACT_VERTS: number[][] = Array.from({ length: 16 }, (_, i) =>
  [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1, i & 8 ? 1 : -1]);
const TESSERACT_EDGES: Array<[number, number]> = [];
for (let a = 0; a < 16; a++) for (let b = a + 1; b < 16; b++) {
  const diff = a ^ b;
  if (!(diff & (diff - 1))) TESSERACT_EDGES.push([a, b]);
}

/**
 * The orrery's hypercube on its own, for use anywhere outside the scene — the
 * boot loader, busy indicators. It is deliberately the same geometry, the same
 * aqua→accent depth ramp, and the same vertex dots as the orrery core rather
 * than a simplified icon, so the app has one canonical tesseract. What differs
 * is the camera: with no drag gesture to read, it tumbles on its own clock.
 */
export function TesseractCore({
  accent,
  className,
}: {
  /** Defaults to the element's inherited CSS `color`. */
  accent?: string;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const accentRef = useRef(accent);
  const reduced = useReducedMotionRef();
  useEffect(() => {
    accentRef.current = accent;
  }, [accent]);
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let w = 0,
      h = 0,
      raf = 0,
      t = 0,
      last = 0,
      dirty = true,
      inherited = "#7de3c8";
    const resize = () => {
      ({ w, h } = fitCanvas(canvas, ctx));
      const color = getComputedStyle(canvas).color;
      if (color) inherited = toHex(color);
      dirty = true;
      // Paint immediately rather than waiting on a frame, so the glyph is never
      // blank on mount or in tabs where rAF is throttled.
      draw();
    };
    const draw = () => {
      const accent = toHex(accentRef.current ?? inherited);
      ctx.clearRect(0, 0, w, h);
      const midX = w / 2,
        midY = h / 2,
        D = 3.4;
      const unit = Math.min(w, h) * 0.5;
      const f = unit * Math.sqrt(D * D - 1);
      const yaw = -0.6 + t * 0.38,
        pitch = 0.18 + Math.sin(t * 0.29) * 0.3;
      const cy = Math.cos(yaw),
        sy = Math.sin(yaw);
      const cp = Math.cos(pitch),
        sp = Math.sin(pitch);
      const project = (x: number, y: number, z: number): [number, number, number] => {
        const rx = x * cy + z * sy, rz = z * cy - x * sy;
        const ry = y * cp - rz * sp, rz2 = y * sp + rz * cp;
        const depth = D - rz2;
        return [midX + rx / depth * f, midY - ry / depth * f, rz2];
      };
      // 0.33 is the largest scale whose worst-case vertex lands inside the box:
      // the w-division and the perspective divide together push the extremes to
      // ~1.3x the nominal size, so anything larger clips against the canvas.
      const scale = 0.33, wDist = 3;
      const planes = [yaw * 0.85, pitch * 0.85, t * 0.3].map(
        angle => [Math.cos(angle), Math.sin(angle)]);
      const points = TESSERACT_VERTS.map(([x, y, z, w]) => {
        let vx = x, vy = y, vz = z, vw = w;
        [vx, vw] = [vx * planes[0][0] + vw * planes[0][1], vw * planes[0][0] - vx * planes[0][1]];
        [vy, vw] = [vy * planes[1][0] + vw * planes[1][1], vw * planes[1][0] - vy * planes[1][1]];
        [vz, vw] = [vz * planes[2][0] + vw * planes[2][1], vw * planes[2][0] - vz * planes[2][1]];
        const k = scale * wDist / (wDist - vw);
        return { screen: project(vx * k, vy * k, vz * k), w: vw };
      });
      ctx.lineWidth = Math.max(0.7, Math.min(w, h) / 46);
      for (const [a, b] of TESSERACT_EDGES) {
        const near = (points[a].w + points[b].w) / 2;
        const front = (points[a].screen[2] + points[b].screen[2]) / 2 >= 0;
        ctx.strokeStyle = rgba(mixHex(AQUA, accent, (near + 1) / 2),
          (0.32 + 0.5 * (near + 1) / 2) * (front ? 1 : 0.5));
        ctx.beginPath();
        ctx.moveTo(points[a].screen[0], points[a].screen[1]);
        ctx.lineTo(points[b].screen[0], points[b].screen[1]);
        ctx.stroke();
      }
      const dot = Math.max(0.6, Math.min(w, h) / 42);
      for (const point of points) {
        ctx.fillStyle = rgba(accent, 0.3 + 0.4 * (point.w + 1) / 2);
        ctx.beginPath();
        ctx.arc(point.screen[0], point.screen[1], dot * (0.72 + 0.28 * (point.w + 1) / 2), 0, Math.PI * 2);
        ctx.fill();
      }
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const delta = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      // Reduced motion still gets the hypercube, just held on one frame.
      if (reduced.current) {
        if (!dirty) return;
        dirty = false;
        draw();
        return;
      }
      t += delta;
      draw();
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);
  return (
    <div className={`tesseract-core${className ? ` ${className}` : ""}`}>
      <canvas ref={canvasRef} aria-hidden="true" />
    </div>
  );
}

/**
 * Lets anything in the tree honour the "Tesseract core" appearance setting
 * without prop-drilling it through every paginator and busy state.
 */
export const SceneEffectsContext = createContext<SceneEffects>({
  starfield: true,
  parallax: true,
  twinkle: true,
  tesseract: true,
  speed: 3,
  starDensity: 4,
});

export function useSceneEffects() {
  return useContext(SceneEffectsContext);
}

const RINGS = [
  { provider: "anthropic", r: 1.55, tiltX: 1.13, tiltZ: -0.31, dir: 1, phase: 1.2 },
  { provider: "openai", r: 1.82, tiltX: 1.36, tiltZ: 0.56, dir: -1, phase: 4.0 },
  { provider: "warp", r: 2.08, tiltX: 0.83, tiltZ: 0.92, dir: 1, phase: 5.45 },
] as const;

const MIN_ORBIT_RATE = 0.22;
const MAX_ORBIT_RATE = 0.62;
const UNKNOWN_ORBIT_RATE = 0.36;

export function headroomOrbitRate(percent: number | null): number {
  if (percent === null || !Number.isFinite(percent)) return UNKNOWN_ORBIT_RATE;
  const normalized = Math.max(0, Math.min(1, percent / 100));
  const eased = normalized * normalized * (3 - 2 * normalized);
  return MIN_ORBIT_RATE + (MAX_ORBIT_RATE - MIN_ORBIT_RATE) * eased;
}

export function HeadroomOrrery({ accent, effects, providerColors, headroom, interactive = true }: { accent: string; effects: SceneEffects; providerColors: ProviderColors; headroom: ProviderHeadroom[]; interactive?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef({ accent, effects, providerColors, headroom });
  const dirtyRef = useRef(true);
  const reduced = useReducedMotionRef();
  useEffect(() => { propsRef.current = { accent, effects, providerColors, headroom }; dirtyRef.current = true; }, [accent, effects, providerColors, headroom]);
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let w = 0, h = 0, raf = 0, drawnVersion = -1, drawnClock = -1;
    const orbitAngles: Record<(typeof RINGS)[number]["provider"], number> = {
      anthropic: RINGS[0].phase,
      openai: RINGS[1].phase,
      warp: RINGS[2].phase,
    };
    let lastOrbitClock = clock;
    const resize = () => { ({ w, h } = fitCanvas(canvas, ctx)); dirtyRef.current = true; };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const draw = (animate: boolean) => {
      const { accent, effects, providerColors, headroom } = propsRef.current;
      ctx.clearRect(0, 0, w, h);
      const midX = w / 2, midY = h / 2;
      const D = 3.4, sphereR = Math.min(w, h) * 0.163;
      const f = sphereR * Math.sqrt(D * D - 1);
      const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
      const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
      // Returns screen x/y plus rotated depth-axis coordinate z (z > 0 faces the viewer).
      const project = (x: number, y: number, z: number): [number, number, number] => {
        const rx = x * cy + z * sy, rz = z * cy - x * sy;
        const ry = y * cp - rz * sp, rz2 = y * sp + rz * cp;
        const depth = D - rz2;
        return [midX + rx / depth * f, midY - ry / depth * f, rz2];
      };

      const backDots: Dot[] = [], frontDots: Dot[] = [];
      const backSegs: Seg[] = [], frontSegs: Seg[] = [];
      for (const ring of RINGS) {
        const signal = headroom.find((item) => item.provider === ring.provider);
        const color = providerColors[ring.provider];
        const known = signal?.percent !== null && signal?.percent !== undefined;
        const normalized = known ? signal.percent! / 100 : 0;
        const staleMultiplier = signal?.state === "stale" ? 0.55 : 1;
        const cosTX = Math.cos(ring.tiltX), sinTX = Math.sin(ring.tiltX);
        const cosTZ = Math.cos(ring.tiltZ), sinTZ = Math.sin(ring.tiltZ);
        const ringPoint = (theta: number): [number, number, number] => {
          const x0 = Math.cos(theta) * ring.r, z0 = Math.sin(theta) * ring.r;
          const y1 = -z0 * sinTX, z1 = z0 * cosTX;
          return [x0 * cosTZ - y1 * sinTZ, x0 * sinTZ + y1 * cosTZ, z1];
        };
        const steps = 96;
        let prev = project(...ringPoint(0));
        for (let i = 1; i <= steps; i++) {
          const point = project(...ringPoint(i / steps * Math.PI * 2));
          const seg = { ax: prev[0], ay: prev[1], bx: point[0], by: point[1], color, alpha: 0 };
          if ((prev[2] + point[2]) / 2 < 0) { seg.alpha = (known ? 0.07 + normalized * 0.05 : 0.07) * staleMultiplier; backSegs.push(seg); }
          else { seg.alpha = (known ? 0.18 + normalized * 0.14 : 0.14) * staleMultiplier; frontSegs.push(seg); }
          prev = point;
        }
        const angle = orbitAngles[ring.provider];
        const pulse = animate && known && normalized > 0 ? 1 + 0.2 * Math.sin(clock * 1.26 + ring.phase) : 1;
        const trailCount = known ? Math.round(18 * normalized) : 0;
        for (let k = trailCount; k >= 0; k--) {
          const [sx, syp, z] = project(...ringPoint(angle - ring.dir * k * 0.055));
          const fade = trailCount ? 1 - k / (trailCount + 1) : 1;
          const exhausted = known && normalized === 0;
          const dot = {
            x: sx, y: syp,
            size: k === 0 ? (known ? (exhausted ? 0.65 : 1.5 + 4.2 * Math.sqrt(normalized)) * pulse : 2.2) : (1 + 2.2 * normalized) * fade,
            color,
            alpha: (k === 0 ? known ? exhausted ? 0.08 : 0.28 + 0.7 * normalized : 0.48 : (0.12 + 0.34 * normalized) * fade) * staleMultiplier,
            hollow: !known && k === 0,
          };
          (z < 0 ? backDots : frontDots).push(dot);
        }
      }
      const drawSegs = (segs: Seg[]) => {
        for (const seg of segs) {
          ctx.strokeStyle = rgba(seg.color, seg.alpha);
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(seg.ax, seg.ay); ctx.lineTo(seg.bx, seg.by); ctx.stroke();
        }
      };
      const drawDots = (dots: Dot[]) => {
        for (const dot of dots) {
          ctx.fillStyle = rgba(dot.color, dot.alpha * 0.25);
          ctx.beginPath(); ctx.arc(dot.x, dot.y, dot.size * 2.4, 0, Math.PI * 2); ctx.fill();
          if (dot.hollow) {
            ctx.strokeStyle = rgba(dot.color, dot.alpha);
            ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.arc(dot.x, dot.y, dot.size, 0, Math.PI * 2); ctx.stroke();
            continue;
          }
          ctx.fillStyle = rgba(dot.color, dot.alpha);
          ctx.beginPath(); ctx.arc(dot.x, dot.y, dot.size, 0, Math.PI * 2); ctx.fill();
        }
      };

      const glow = ctx.createRadialGradient(midX, midY, 0, midX, midY, sphereR * 2.7);
      glow.addColorStop(0, rgba(accent, 0.16));
      glow.addColorStop(1, rgba(accent, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      drawSegs(backSegs);
      drawDots(backDots);

      const shade = ctx.createRadialGradient(midX - sphereR * 0.3, midY - sphereR * 0.4, 0, midX - sphereR * 0.3, midY - sphereR * 0.4, sphereR * 1.9);
      shade.addColorStop(0, mixHex("#101b16", accent, 0.42));
      shade.addColorStop(0.42, "#101916");
      shade.addColorStop(0.75, "#0c130b");
      shade.addColorStop(1, "#0a1109");
      ctx.fillStyle = shade;
      ctx.beginPath(); ctx.arc(midX, midY, sphereR, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = rgba(accent, 0.2);
      ctx.lineWidth = 1;
      ctx.stroke();

      // Graticule: 3 longitude + 2 latitude lines on the front hemisphere.
      ctx.strokeStyle = rgba(accent, 0.24);
      const lines: Array<(theta: number) => [number, number, number]> = [
        ...[0, Math.PI / 3, Math.PI * 2 / 3].map(phi =>
          (theta: number): [number, number, number] => [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)]),
        ...[-0.45, 0.45].map(y0 => {
          const lr = Math.sqrt(1 - y0 * y0);
          return (theta: number): [number, number, number] => [Math.cos(theta) * lr, y0, Math.sin(theta) * lr];
        }),
      ];
      for (const line of lines) {
        ctx.beginPath();
        let pen = false;
        for (let i = 0; i <= 72; i++) {
          const [sx, syp, z] = project(...line(i / 72 * Math.PI * 2));
          if (z > 0.03) { pen ? ctx.lineTo(sx, syp) : ctx.moveTo(sx, syp); pen = true; }
          else pen = false;
        }
        ctx.stroke();
      }

      // Optional tesseract core: dragging the camera rotates the hypercube
      // through the xw/yw planes, so the same gesture that spins the sphere
      // folds the inner cube through the outer one. The zw plane drifts on the
      // shared clock for ambient contortion, and the projected 3D shape rides
      // the scene camera via `project` so it stays seated in the sphere.
      if (effects.tesseract) {
        const scale = 0.3, wDist = 3;
        const planes = [camera.yaw * 0.85, camera.pitch * 0.85, clock * 0.3].map(
          angle => [Math.cos(angle), Math.sin(angle)]);
        const points = TESSERACT_VERTS.map(([x, y, z, w]) => {
          let vx = x, vy = y, vz = z, vw = w;
          [vx, vw] = [vx * planes[0][0] + vw * planes[0][1], vw * planes[0][0] - vx * planes[0][1]];
          [vy, vw] = [vy * planes[1][0] + vw * planes[1][1], vw * planes[1][0] - vy * planes[1][1]];
          [vz, vw] = [vz * planes[2][0] + vw * planes[2][1], vw * planes[2][0] - vz * planes[2][1]];
          const k = scale * wDist / (wDist - vw);
          return { screen: project(vx * k, vy * k, vz * k), w: vw };
        });
        ctx.lineWidth = 1.2;
        for (const [a, b] of TESSERACT_EDGES) {
          const near = (points[a].w + points[b].w) / 2;
          const front = (points[a].screen[2] + points[b].screen[2]) / 2 >= 0;
          ctx.strokeStyle = rgba(mixHex(AQUA, accent, (near + 1) / 2),
            (0.24 + 0.38 * (near + 1) / 2) * (front ? 1 : 0.5));
          ctx.beginPath();
          ctx.moveTo(points[a].screen[0], points[a].screen[1]);
          ctx.lineTo(points[b].screen[0], points[b].screen[1]);
          ctx.stroke();
        }
        for (const point of points) {
          ctx.fillStyle = rgba(accent, 0.3 + 0.4 * (point.w + 1) / 2);
          ctx.beginPath();
          ctx.arc(point.screen[0], point.screen[1], 1.3 + 0.5 * (point.w + 1) / 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      drawSegs(frontSegs);
      drawDots(frontDots);
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const animate = !reduced.current;
      stepScene(now, animate, propsRef.current.effects.speed);
      const orbitDelta = Math.max(0, clock - lastOrbitClock);
      lastOrbitClock = clock;
      if (orbitDelta > 0) {
        for (const ring of RINGS) {
          const signal = propsRef.current.headroom.find(
            (item) => item.provider === ring.provider,
          );
          orbitAngles[ring.provider] +=
            orbitDelta * headroomOrbitRate(signal?.percent ?? null) * ring.dir;
        }
      }
      // Repaint only on invalidation, camera motion, or ambient time advancing (orbits,
      // pulse). At speed 0 with a settled camera this skips every frame.
      if (!dirtyRef.current && camera.version === drawnVersion && clock === drawnClock) return;
      drawnVersion = camera.version;
      drawnClock = clock;
      dirtyRef.current = false;
      draw(animate);
    };
    raf = requestAnimationFrame(frame);

    let px = 0, py = 0, moveTime = 0;
    const down = (event: PointerEvent) => {
      canvas.setPointerCapture(event.pointerId);
      camera.dragging = true;
      camera.vyaw = 0; camera.vpitch = 0;
      px = event.clientX; py = event.clientY;
      moveTime = performance.now();
      camera.lastInput = moveTime;
    };
    const move = (event: PointerEvent) => {
      if (!camera.dragging) return;
      const now = performance.now(), dt = Math.max(8, now - moveTime) / 1000;
      const dx = event.clientX - px, dy = event.clientY - py;
      px = event.clientX; py = event.clientY; moveTime = now;
      camera.yaw += dx * DRAG;
      camera.pitch += dy * DRAG;
      camera.vyaw = Math.max(-3, Math.min(3, camera.vyaw * 0.7 + dx * DRAG / dt * 0.3));
      camera.vpitch = Math.max(-3, Math.min(3, camera.vpitch * 0.7 + dy * DRAG / dt * 0.3));
      camera.lastInput = now;
      camera.version++;
    };
    const up = () => {
      if (!camera.dragging) return;
      camera.dragging = false;
      const now = performance.now();
      if (now - moveTime > 120) { camera.vyaw = 0; camera.vpitch = 0; }
      camera.lastInput = now;
    };
    // A second mounted orrery must not also feed the shared camera — window-level
    // move handlers from every instance would each apply the same drag delta.
    if (interactive) {
      canvas.addEventListener("pointerdown", down);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    }
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);
  return <div className={interactive ? "headroom-orrery" : "headroom-orrery headroom-orrery--static"}>
    <div className="headroom-orrery__visual">
      <canvas ref={canvasRef} aria-hidden="true" />
      {!effects.tesseract && <div className="scene-icon" aria-hidden="true"><TelescopeIcon /></div>}
    </div>
    <div className="headroom-orrery__legend" aria-label="Provider quota headroom">
      {headroom.map((signal) => {
        const label = signal.provider === "openai" ? "OpenAI" : signal.provider === "anthropic" ? "Anthropic" : "Warp";
        const value = signal.percent === null ? "Unknown" : `${Math.round(signal.percent)}%`;
        return <div key={signal.provider}><i style={{ background: providerColors[signal.provider], color: providerColors[signal.provider] }} /><span>{label}</span><b>{value}</b>{signal.state === "stale" && <small>stale</small>}</div>;
      })}
    </div>
  </div>;
}
