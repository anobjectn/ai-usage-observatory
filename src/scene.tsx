import { useEffect, useRef } from "react";
import { Telescope } from "lucide-react";
import type { ProviderHeadroom } from "./quota-headroom";

export type SceneEffects = { starfield: boolean; parallax: boolean; twinkle: boolean; speed: number; starDensity: number };
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
  camera.vyaw += ((idle ? AUTO_YAW * speed : 0) - camera.vyaw) * pull;
  camera.vpitch -= camera.vpitch * pull;
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
    let w = 0, h = 0, raf = 0, drawnVersion = -1, baseStarCount = 0;
    let stars: Star[] = [];
    const resize = () => {
      ({ w, h } = fitCanvas(canvas, ctx));
      // Stars fill the whole sky sphere but the camera only sees a narrow cone,
      // so scale the on-screen density target by the visible solid-angle share.
      const f = h * 0.8;
      const coverage = Math.atan(w / 2 / f) * Math.atan(h / 2 / f) / Math.PI;
      baseStarCount = Math.min(6000, Math.round(w * h / 3200 / Math.max(0.02, coverage)));
      stars = makeStars(Math.min(30000, Math.round(baseStarCount * STAR_DENSITY_MULTIPLIERS[MAX_STAR_DENSITY])));
      dirtyRef.current = true;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const animate = !reduced.current;
      stepScene(now, animate, propsRef.current.effects.speed);
      if (!animate && !dirtyRef.current && camera.version === drawnVersion) return;
      drawnVersion = camera.version;
      dirtyRef.current = false;
      const { accent, effects } = propsRef.current;
      ctx.clearRect(0, 0, w, h);
      const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
      const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
      const f = h * 0.8, midX = w / 2, midY = h / 2, D = 2.5;
      const density = Math.min(MAX_STAR_DENSITY, Math.max(1, Math.round(effects.starDensity)));
      const visibleStarCount = Math.min(stars.length, Math.round(baseStarCount * STAR_DENSITY_MULTIPLIERS[density]));
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

const RINGS = [
  { provider: "anthropic", r: 1.55, tiltX: 1.13, tiltZ: -0.31, speed: 0.5, dir: 1, phase: 1.2 },
  { provider: "openai", r: 1.82, tiltX: 1.36, tiltZ: 0.56, speed: 0.36, dir: -1, phase: 4.0 },
  { provider: "warp", r: 2.08, tiltX: 0.83, tiltZ: 0.92, speed: 0.29, dir: 1, phase: 5.45 },
] as const;

export function OrbitalScene({ accent, effects, providerColors, headroom }: { accent: string; effects: SceneEffects; providerColors: ProviderColors; headroom: ProviderHeadroom[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef({ accent, effects, providerColors, headroom });
  const dirtyRef = useRef(true);
  const reduced = useReducedMotionRef();
  useEffect(() => { propsRef.current = { accent, effects, providerColors, headroom }; dirtyRef.current = true; }, [accent, effects, providerColors, headroom]);
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let w = 0, h = 0, raf = 0, drawnVersion = -1;
    const resize = () => { ({ w, h } = fitCanvas(canvas, ctx)); dirtyRef.current = true; };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const draw = (animate: boolean) => {
      const { accent, providerColors, headroom } = propsRef.current;
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
        const angle = ring.phase + clock * ring.speed * ring.dir;
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

      drawSegs(frontSegs);
      drawDots(frontDots);
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const animate = !reduced.current;
      stepScene(now, animate, propsRef.current.effects.speed);
      if (!animate && !dirtyRef.current && camera.version === drawnVersion) return;
      drawnVersion = camera.version;
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
    canvas.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);
  return <div className="orbital-viz">
    <canvas ref={canvasRef} aria-hidden="true" />
    <div className="scene-icon" aria-hidden="true"><Telescope /></div>
    <div className="orbit-legend" aria-label="Provider quota headroom">
      {headroom.map((signal) => {
        const label = signal.provider === "openai" ? "OpenAI" : signal.provider === "anthropic" ? "Anthropic" : "Warp";
        const value = signal.percent === null ? "Unknown" : `${Math.round(signal.percent)}%`;
        return <div key={signal.provider}><i style={{ background: providerColors[signal.provider], color: providerColors[signal.provider] }} /><span>{label}</span><b>{value}</b>{signal.state === "stale" && <small>stale</small>}</div>;
      })}
    </div>
  </div>;
}
