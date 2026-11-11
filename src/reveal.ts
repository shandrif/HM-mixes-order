// Scroll reveal: cards, rows and stats rise + fade in the first time they enter
// the viewport (transform/opacity only, once per element). Works for elements
// added later (route changes, loaded data). Off when reduced motion is preferred.
const SELECTOR = [
  ".card",
  ".stat",
  ".sp-card",
  ".sp-totals li",
  ".m-branches li",
  ".m-items .m-item",
  "table.list.stack tbody tr",
  ".issue-list li",
  ".delivery-list li",
  ".chips .chip",
  ".m-preview-link",
  ".m-hero",
  ".sp-head",
  ".page-head.hero",
].join(",");

export function installReveal() {
  if (typeof window === "undefined" || !("IntersectionObserver" in window)) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const done = (el: HTMLElement) => {
    el.classList.remove("rv", "rv-in");
    el.style.removeProperty("--rd");
  };

  const io = new IntersectionObserver(
    (entries) => {
      let n = 0;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        io.unobserve(el);
        // Elements entering together cascade 40ms apart (capped).
        el.style.setProperty("--rd", `${Math.min(n++, 8) * 40}ms`);
        requestAnimationFrame(() => el.classList.add("rv-in"));
        // Hand the element back to its own styles once revealed.
        const clean = () => done(el);
        el.addEventListener("transitionend", clean, { once: true });
        setTimeout(clean, 1200);
      }
    },
    { rootMargin: "0px 0px -4% 0px", threshold: 0.04 },
  );

  const scan = (root: ParentNode) => {
    root.querySelectorAll<HTMLElement>(SELECTOR).forEach((el) => {
      if (el.dataset.rv) return;
      el.dataset.rv = "1";
      el.classList.add("rv");
      io.observe(el);
    });
  };

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      scan(document);
    });
  }).observe(document.body, { childList: true, subtree: true });
  scan(document);
}
