// Interactive background: lights follow the cursor (or finger) with a spring-like
// lag, move with parallax as you scroll, and shift from warm gold to cool mint the
// further down the page you go. One rAF loop writes transform/opacity directly on a
// handful of layers (no CSS-variable cascades, no layout). Paused while the tab is
// hidden; not started when the user prefers reduced motion.
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function installAmbient() {
  if (typeof window === "undefined") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const finePointer = window.matchMedia("(pointer: fine)").matches;

  let root: HTMLElement | null = null;
  let warm: HTMLElement[] = [];
  let cool: HTMLElement[] = [];
  let warmLayer: HTMLElement | null = null;
  let coolLayer: HTMLElement | null = null;
  let glow: HTMLElement | null = null;

  const bind = () => {
    const r = document.querySelector<HTMLElement>(".ambient");
    if (r === root) return !!root;
    root = r;
    if (!root) return false;
    warmLayer = root.querySelector(".amb-warm");
    coolLayer = root.querySelector(".amb-cool");
    warm = [...root.querySelectorAll<HTMLElement>(".amb-warm i")];
    cool = [...root.querySelectorAll<HTMLElement>(".amb-cool i")];
    glow = root.querySelector(".amb-cursor");
    return true;
  };

  // Pointer: normalised target (-1..1) for the lights, pixels for the glow.
  let tx = 0, ty = 0, cx = 0, cy = 0;
  let gx = innerWidth / 2, gy = innerHeight / 3, gtx = gx, gty = gy;
  let glowOn = false;
  // Scroll: progress 0..1 of whatever is scrolling, plus velocity.
  let sp = 0, csp = 0, vel = 0, lastTop = 0, lastT = performance.now();

  const onPointer = (e: PointerEvent) => {
    tx = (e.clientX / innerWidth) * 2 - 1;
    ty = (e.clientY / innerHeight) * 2 - 1;
    gtx = e.clientX;
    gty = e.clientY;
    if (finePointer || e.pointerType !== "mouse") glowOn = e.pointerType === "mouse" || e.buttons > 0 || e.type === "pointerdown";
  };
  window.addEventListener("pointermove", onPointer, { passive: true });
  window.addEventListener("pointerdown", onPointer, { passive: true });
  window.addEventListener("pointerup", (e) => { if (e.pointerType !== "mouse") glowOn = false; }, { passive: true });
  document.addEventListener("pointerleave", () => (glowOn = false));
  window.addEventListener("blur", () => (glowOn = false));

  // Scroll events don't bubble, but a capturing listener on document sees every scroller.
  document.addEventListener(
    "scroll",
    (e) => {
      const el = e.target === document ? document.scrollingElement! : (e.target as HTMLElement);
      if (!el || el.classList?.contains("sheet-wrap")) return; // sideways table scroll isn't page scroll
      const max = el.scrollHeight - el.clientHeight;
      sp = max > 0 ? el.scrollTop / max : 0;
      const now = performance.now();
      vel = (el.scrollTop - lastTop) / Math.max(1, now - lastT); // px per ms
      lastTop = el.scrollTop;
      lastT = now;
    },
    { passive: true, capture: true },
  );

  // Spotlight on cards and heroes (only the hovered element repaints).
  let pending: { el: HTMLElement; x: number; y: number } | null = null;
  const SPOT = ".m-hero, .sp-head, .page-head.hero, .card, .stat, .sp-card, .m-preview-link";
  window.addEventListener(
    "pointermove",
    (e) => {
      const el = (e.target as Element | null)?.closest?.(SPOT) as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      pending = { el, x: e.clientX - r.left, y: e.clientY - r.top };
    },
    { passive: true },
  );

  let raf = 0;
  const frame = (t: number) => {
    raf = requestAnimationFrame(frame);
    if (!bind()) return;
    // Springy follow: lights drift slowly toward the pointer, the glow faster.
    cx = lerp(cx, tx, 0.045);
    cy = lerp(cy, ty, 0.045);
    gx = lerp(gx, gtx, 0.14);
    gy = lerp(gy, gty, 0.14);
    csp = lerp(csp, sp, 0.08);
    vel = lerp(vel, 0, 0.06);
    const stretch = Math.min(0.12, Math.abs(vel) * 0.05);
    const W = innerWidth, H = innerHeight;

    warm.forEach((el, i) => {
      const depth = 1 + i * 0.7;
      const dx = Math.sin(t / (8000 + i * 2600) + i) * W * 0.06 + cx * W * 0.05 * depth;
      const dy = Math.cos(t / (9500 + i * 2100) + i * 2) * H * 0.05 + cy * H * 0.05 * depth - csp * H * 0.35 * depth;
      el.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0) scale(${(1 + stretch + Math.sin(t / 7000 + i) * 0.04).toFixed(3)}, ${(1 - stretch * 0.5).toFixed(3)})`;
    });
    cool.forEach((el, i) => {
      const depth = 1.4 + i * 0.6;
      const dx = Math.cos(t / (10000 + i * 1800) + i) * W * 0.07 - cx * W * 0.06 * depth;
      const dy = Math.sin(t / (8800 + i * 2400)) * H * 0.05 - cy * H * 0.04 * depth + (1 - csp) * H * 0.25 * depth;
      el.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0) scale(${(1 + stretch).toFixed(3)})`;
    });
    // Warm at the top of a page, cool further down.
    if (warmLayer) warmLayer.style.opacity = (1 - csp * 0.55).toFixed(3);
    if (coolLayer) coolLayer.style.opacity = (0.25 + csp * 0.75).toFixed(3);
    if (glow) {
      glow.style.transform = `translate3d(${(gx - 320).toFixed(1)}px, ${(gy - 320).toFixed(1)}px, 0)`;
      glow.classList.toggle("on", glowOn);
    }
    if (pending) {
      pending.el.style.setProperty("--mx", `${pending.x}px`);
      pending.el.style.setProperty("--my", `${pending.y}px`);
      pending = null;
    }
  };

  const start = () => { if (!raf) raf = requestAnimationFrame(frame); };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  start();
}
