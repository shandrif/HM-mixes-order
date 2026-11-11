// Click ripple: a water-drop splash from the touch point — a small lit droplet
// lands, then a few bevelled rings (bright crest, shadowed trough) spread out
// like waves on a water surface.
// Transform + opacity only (GPU), via the Web Animations API, so it never blocks
// input and is interrupted cleanly by the next press. Pointer-only (keyboard
// presses don't ripple) and off when the user prefers reduced motion.
const SELECTOR = [
  ".btn",
  ".m-primary",
  ".m-secondary",
  ".m-chip-btn",
  ".m-branch",
  ".admin-nav nav a",
  "a.stat",
  ".seg button",
  ".store-chip",
  "[data-ripple]",
].join(",");

// Steppers are pressed dozens of times per order: scale feedback only.
const EXCLUDE = ".m-step, [data-no-ripple]";

const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

export function installRipple() {
  if (typeof window === "undefined") return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (reduced.matches || e.button !== 0) return;
      const host = (e.target as Element | null)?.closest?.(SELECTOR) as HTMLElement | null;
      if (!host || host.closest(EXCLUDE) || host.matches(":disabled") || host.getAttribute("aria-disabled") === "true") return;
      const rect = host.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // Radius that reaches the farthest corner
      const r = Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y));
      splash(host, x, y, r);
    },
    { passive: true, capture: true },
  );
}

/** Water-drop splash: droplet + three staggered 3D rings. */
function splash(host: HTMLElement, x: number, y: number, r: number) {
  const wrap = document.createElement("span");
  wrap.className = "ripple-water";
  wrap.style.width = wrap.style.height = `${r * 2}px`;
  wrap.style.left = `${x - r}px`;
  wrap.style.top = `${y - r}px`;

  const parts: Animation[] = [];
  const drop = document.createElement("span");
  drop.className = "rw-drop";
  wrap.appendChild(drop);
  for (let i = 0; i < 3; i++) {
    const ring = document.createElement("span");
    ring.className = "rw-ring";
    wrap.appendChild(ring);
  }
  host.appendChild(wrap);

  // The droplet hits and sinks into the surface.
  parts.push(
    drop.animate(
      [
        { transform: "scale(0.05)", opacity: 0 },
        { transform: "scale(1)", opacity: 1, offset: 0.35 },
        { transform: "scale(0.6)", opacity: 0 },
      ],
      { duration: 380, easing: EASE_OUT, fill: "forwards" },
    ),
  );
  // Waves: each later ring is smaller and fainter, like real ripples.
  wrap.querySelectorAll<HTMLElement>(".rw-ring").forEach((ring, i) => {
    const end = 1 - i * 0.22;
    parts.push(
      ring.animate(
        [
          { transform: "scale(0.04)", opacity: 0 },
          { transform: `scale(${end * 0.25})`, opacity: 1 - i * 0.2, offset: 0.12 },
          { transform: `scale(${end})`, opacity: 0 },
        ],
        { duration: 900, delay: 70 + i * 120, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)", fill: "both" },
      ),
    );
  });
  Promise.all(parts.map((p) => p.finished)).then(
    () => wrap.remove(),
    () => wrap.remove(),
  );
}
