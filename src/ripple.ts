// Click ripple: a soft circle spreading from the touch point.
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
// Store screens (.m-shell) use clay squash-and-spring feedback instead.
const EXCLUDE = ".m-step, .m-shell, [data-no-ripple]";

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
      const dot = document.createElement("span");
      dot.className = "ripple";
      dot.style.width = dot.style.height = `${r * 2}px`;
      dot.style.left = `${x - r}px`;
      dot.style.top = `${y - r}px`;
      host.appendChild(dot);
      const anim = dot.animate(
        [
          { transform: "scale(0.12)", opacity: 0.34 },
          { transform: "scale(1)", opacity: 0 },
        ],
        { duration: 420, easing: EASE_OUT, fill: "forwards" },
      );
      anim.onfinish = anim.oncancel = () => dot.remove();
    },
    { passive: true, capture: true },
  );
}
