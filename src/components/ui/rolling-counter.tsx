"use client";

// Rolling counter (from the provided component), with three additive changes for
// this app — defaults keep the original behaviour:
//  - `decimals`: show fractional steps, e.g. 0.5 tubs (values are handled in
//    integer units internally so the digit columns still roll).
//  - `unset`: render a faint 0 for "not entered yet"; pressing − records min.
//  - `touch-none` on the digit area so dragging on a phone changes the number
//    instead of scrolling the page.
//  - `size="sm"`: a compact version for lists (default size unchanged).
//  - `scrubbable={false}`: turn off drag-to-change (avoids accidental changes).
//  - `editable`: tap the number to type a value (Enter/blur saves, Esc cancels).
//  - controlled value changes from outside (e.g. "Copy last order") now roll the
//    digits too (the original compared against the already-updated render value).

import * as React from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

export interface RollingCounterProps {
  /** Controlled numeric value */
  value?: number;
  /** Initial value for uncontrolled mode (defaults to 100) */
  defaultValue?: number;
  /** Callback fired whenever value changes */
  onChange?: (value: number) => void;
  /** Minimum allowed value */
  min?: number;
  /** Maximum allowed value */
  max?: number;
  /** Step increment per click */
  step?: number;
  /** Digits after the decimal point (0 = whole numbers, 1 = e.g. 0.5) */
  decimals?: number;
  /** Show as "not entered yet" (faint digits); − then sets the minimum */
  unset?: boolean;
  /** "sm" = compact (30px buttons) */
  size?: "default" | "sm";
  /** Drag the number up/down to change it (default true) */
  scrubbable?: boolean;
  /** Tap the number to type a value */
  editable?: boolean;
  /** Spring bounce elasticity (0 to 100) */
  bounce?: number;
  /** Stagger delay between columns in ms */
  stagger?: number;
  /** Motion blur smear factor (0 to 100) */
  blur?: number;
  /** Disables the counter */
  disabled?: boolean;
  /** Accessible name, e.g. the item name */
  label?: string;
  /** Additional custom class names */
  className?: string;
}

const PLACES = 5;
const CELL_HEIGHTS = { default: 42, sm: 30 } as const;
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1];

const getSpring = (tune: number) => ({
  k: 0.1 + (tune / 100) * 0.16,
  d: 0.64 + (tune / 100) * 0.18,
});

const isReducedMotion = () =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

type ColState = {
  pos: number;
  vel: number;
  target: number;
  due: number[];
  next: number[];
};

export function RollingCounter({
  value: controlledValue,
  defaultValue = 100,
  onChange,
  min = 0,
  max,
  step = 1,
  decimals = 0,
  unset = false,
  editable = false,
  scrubbable = true,
  size = "default",
  bounce = 40,
  stagger = 32,
  blur = 24,
  disabled = false,
  label,
  className,
}: RollingCounterProps) {
  // All maths in integer "units" (value × 10^decimals) so each column is a digit.
  const scale = 10 ** decimals;
  const toU = (v: number) => Math.round(v * scale);
  const isControlled = controlledValue !== undefined;
  const minU = toU(min);
  const maxU = max !== undefined ? toU(max) : 10 ** PLACES - 1;
  const stepU = Math.max(1, toU(step));
  const initial = clamp(toU(isControlled ? controlledValue : defaultValue), minU, maxU);

  const [uncontrolledVal, setUncontrolledVal] = React.useState<number>(initial);
  const activeValue = clamp(isControlled ? toU(controlledValue) : uncontrolledVal, minU, maxU);

  const valRef = React.useRef(activeValue);
  valRef.current = activeValue;
  // Last value the digit columns were sent to (so outside changes can be detected).
  const shownRef = React.useRef(initial);

  const strips = React.useRef<(HTMLDivElement | null)[]>([]);
  const cols = React.useRef<ColState[]>(
    Array.from({ length: PLACES }, (_, p) => {
      const n = Math.floor(initial / 10 ** p);
      return { pos: n, vel: 0, target: n, due: [], next: [] };
    })
  );

  const raf = React.useRef<number>(0);
  const flingRaf = React.useRef<number>(0);
  const holdTimer = React.useRef<{ timer: number; start: number }>({ timer: 0, start: 0 });
  const dragTracker = React.useRef<{
    y: number;
    acc: number;
    vel: number;
    time: number;
    moved: number;
  } | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");

  const sm = size === "sm";
  const CELL_HEIGHT = CELL_HEIGHTS[size];
  const cellRef = React.useRef(CELL_HEIGHT);
  cellRef.current = CELL_HEIGHT;
  const tuning = React.useRef({ bounce, stagger, blur });
  tuning.current = { bounce, stagger, blur };

  /* ── Smooth Render & Smear ── */
  const paint = React.useCallback(() => {
    cols.current.forEach((col, p) => {
      const el = strips.current[p];
      if (!el) return;
      const normalizedMod = ((col.pos % 10) + 10) % 10;
      const smear = Math.min(2.2, Math.abs(col.vel) * 1.8) * (tuning.current.blur / 50);

      el.style.transform = `translate3d(0, ${-normalizedMod * cellRef.current}px, 0)`;
      el.style.filter = smear > 0.12 ? `blur(${smear.toFixed(2)}px)` : "none";
    });
  }, []);

  const runSimulation = React.useCallback(() => {
    if (raf.current) return;
    let lastTime = 0;

    const tick = (time: number) => {
      const dt = lastTime ? clamp((time - lastTime) / 16.67, 0, 2.5) : 1;
      lastTime = time;

      const { k, d } = getSpring(tuning.current.bounce);
      const now = performance.now();
      let active = false;

      for (const col of cols.current) {
        while (col.due.length && col.due[0] <= now) {
          col.due.shift();
          col.target = col.next.shift()!;
        }
        if (col.due.length) active = true;

        const delta = col.target - col.pos;
        if (Math.abs(delta) > 20) {
          col.pos += Math.round((delta - Math.sign(delta) * 20) / 10) * 10;
        }

        col.vel += (col.target - col.pos) * k * dt;
        col.vel *= Math.pow(d, dt);
        col.pos += col.vel * dt;

        if (Math.abs(col.target - col.pos) < 0.003 && Math.abs(col.vel) < 0.003) {
          col.pos = col.target;
          col.vel = 0;
        } else {
          active = true;
        }
      }

      paint();
      raf.current = active ? requestAnimationFrame(tick) : 0;
    };

    raf.current = requestAnimationFrame(tick);
  }, [paint]);

  /** Roll the digit columns to `to` (units). */
  const animateTo = React.useCallback(
    (to: number) => {
      shownRef.current = to;
      const reduced = isReducedMotion();
      const now = performance.now();
      cols.current.forEach((col, p) => {
        const target = Math.floor(to / 10 ** p);
        if (reduced) {
          col.pos = col.target = target;
          col.vel = 0;
          col.due = [];
          col.next = [];
        } else {
          col.due.push(now + p * tuning.current.stagger);
          col.next.push(target);
        }
      });
      if (reduced) paint();
      else runSimulation();
    },
    [paint, runSimulation]
  );

  /* ── Dispatch Mutation ── */
  const commitValue = React.useCallback(
    (targetVal: number) => {
      if (disabled) return;
      const nextVal = clamp(targetVal, minU, maxU);
      if (nextVal === valRef.current) return;

      valRef.current = nextVal;
      if (!isControlled) {
        setUncontrolledVal(nextVal);
      }
      onChange?.(nextVal / scale);
      animateTo(nextVal);
    },
    [disabled, isControlled, maxU, minU, onChange, scale, animateTo]
  );

  const bump = React.useCallback(
    (multiplier = 1) => {
      commitValue(valRef.current + stepU * multiplier);
    },
    [commitValue, stepU]
  );

  // Outside changes to a controlled value (e.g. "Copy last order") roll too.
  React.useEffect(() => {
    if (isControlled && activeValue !== shownRef.current) animateTo(activeValue);
  }, [activeValue, isControlled, animateTo]);

  React.useEffect(() => {
    paint();
  }, [blur, paint]);

  React.useEffect(() => {
    return () => {
      cancelAnimationFrame(raf.current);
      cancelAnimationFrame(flingRaf.current);
      clearTimeout(holdTimer.current.timer);
    };
  }, []);

  /* ── Continuous Press / Hold ── */
  const handleHoldEnd = () => {
    clearTimeout(holdTimer.current.timer);
    holdTimer.current.timer = 0;
  };

  const handleHoldStart = (dir: 1 | -1) => {
    if (disabled) return;
    handleHoldEnd();
    // "Not entered yet" + minus = an explicit minimum (e.g. 0).
    if (unset && dir === -1 && valRef.current <= minU) {
      onChange?.(minU / scale);
      return;
    }
    bump(dir);
    holdTimer.current.start = performance.now();

    const repeatLoop = () => {
      const elapsed = performance.now() - holdTimer.current.start;
      const speedUp = elapsed > 1400 ? 10 : elapsed > 700 ? 5 : 1;
      bump(dir * speedUp);
      holdTimer.current.timer = window.setTimeout(repeatLoop, elapsed > 700 ? 55 : 85);
    };
    holdTimer.current.timer = window.setTimeout(repeatLoop, 320);
  };

  /* ── Vertical Drag & Inertia ── */
  const DRAG_PX = 12;
  const processOffset = (acc: number) => {
    const ticks = acc > 0 ? Math.floor(acc / DRAG_PX) : Math.ceil(acc / DRAG_PX);
    if (ticks) bump(ticks);
    return acc - ticks * DRAG_PX;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    cancelAnimationFrame(flingRaf.current);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    dragTracker.current = { y: e.clientY, acc: 0, vel: 0, time: performance.now(), moved: 0 };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const track = dragTracker.current;
    if (!track) return;
    const now = performance.now();
    const dy = track.y - e.clientY;
    track.y = e.clientY;
    track.moved += Math.abs(dy);
    const dt = Math.max(1, now - track.time);
    track.time = now;
    track.vel = track.vel * 0.6 + (dy / dt) * 0.4;
    if (scrubbable) track.acc = processOffset(track.acc + dy);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const track = dragTracker.current;
    dragTracker.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
    if (!track) return;
    // A tap (no drag) opens typing.
    if (editable && e.type === "pointerup" && track.moved < 6) {
      startEditing();
      return;
    }
    if (!scrubbable || isReducedMotion()) return;

    let v = performance.now() - track.time > 80 ? 0 : track.vel * 16.67;
    if (Math.abs(v) < 1.5) return;

    let acc = track.acc;
    const coast = () => {
      acc = processOffset(acc + v);
      v *= 0.93;
      if (Math.abs(v) > 0.35) flingRaf.current = requestAnimationFrame(coast);
    };
    flingRaf.current = requestAnimationFrame(coast);
  };

  /* ── Typing ── */
  const startEditing = () => {
    if (disabled) return;
    setDraft(unset ? "" : String(valRef.current / scale));
    setEditing(true);
  };
  const finishEditing = (save: boolean) => {
    setEditing(false);
    if (!save) return;
    // Arabic-Indic digits → 0-9, then keep only digits and one point.
    const raw = draft.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[٫,]/g, ".").replace(/[^\d.]/g, "");
    // Deleted everything = 0 (the minimum).
    if (raw === "" || raw === ".") {
      if (valRef.current !== minU) commitValue(minU);
      else if (unset) onChange?.(minU / scale);
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const units = Math.round(toU(n) / stepU) * stepU;
    const next = clamp(units, minU, maxU);
    if (next === valRef.current) {
      if (unset) onChange?.(next / scale);
      return;
    }
    commitValue(next);
  };

  const shownDigits = Math.max(1 + decimals, String(activeValue).length);
  const display = (activeValue / scale).toFixed(decimals);

  return (
    <div
      className={cn(
        // Outer Pill Frame: Exact concentric radius (R_outer = R_inner + padding = 14px + 5px = 19px -> rounded-[20px])
        "relative inline-flex items-center justify-center bg-[#161618] text-white",
        sm ? "p-[3px] rounded-[13px]" : "p-[5px] rounded-[20px]",
        "border border-white/[0.08] shadow-[0_8px_28px_-6px_rgba(0,0,0,0.65),inset_0_1px_0_0_rgba(255,255,255,0.08)]",
        disabled && "opacity-50 pointer-events-none cursor-not-allowed",
        className
      )}
    >
      {/* Minus Button */}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Decrease value"
        disabled={disabled || (activeValue <= minU && !unset)}
        onPointerDown={() => handleHoldStart(-1)}
        onPointerUp={handleHoldEnd}
        onPointerLeave={handleHoldEnd}
        onPointerCancel={handleHoldEnd}
        className={cn(
          "flex items-center justify-center",
          sm ? "w-[30px] h-[30px] rounded-[10px]" : "w-[42px] h-[42px] rounded-[14px]",
          "bg-[#242427] text-neutral-300 border border-white/[0.05]",
          "hover:bg-[#2d2d31] hover:text-white hover:border-white/[0.1]",
          "active:scale-[0.96] active:bg-[#1e1e21]",
          "transition-all duration-150 ease-out select-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400",
          "disabled:opacity-30 disabled:pointer-events-none"
        )}
      >
        <Minus className={cn(sm ? "w-[14px] h-[14px]" : "w-[18px] h-[18px]", "stroke-[2.4]")} />
      </button>

      {/* Scrubbable Digit Area */}
      <div
        role="spinbutton"
        tabIndex={disabled ? -1 : 0}
        aria-valuenow={unset ? undefined : activeValue / scale}
        aria-valuetext={unset ? "Not entered" : display}
        aria-valuemin={min}
        aria-valuemax={maxU / scale}
        aria-label={label ?? "Rolling counter. Drag vertically or use arrow keys."}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "ArrowUp") {
            e.preventDefault();
            bump(1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            if (unset && valRef.current <= minU) onChange?.(minU / scale);
            else bump(-1);
          } else if (e.key === "PageUp") {
            e.preventDefault();
            bump(10);
          } else if (e.key === "PageDown") {
            e.preventDefault();
            bump(-10);
          } else if (e.key === "Home") {
            e.preventDefault();
            commitValue(minU);
          } else if (e.key === "End") {
            e.preventDefault();
            commitValue(maxU);
          } else if (editable && (e.key === "Enter" || /^[0-9٠-٩]$/.test(e.key))) {
            e.preventDefault();
            startEditing();
            if (e.key !== "Enter") setDraft(e.key);
          }
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={cn(
          sm ? "h-[30px] min-w-[40px] px-2 text-[17px]" : "h-[42px] min-w-[56px] px-3.5 text-[25px]",
          "relative flex items-center justify-center overflow-hidden",
          scrubbable ? "cursor-ns-resize touch-none" : editable ? "cursor-text" : "cursor-default",
          "font-sans font-semibold leading-none text-white tracking-[-0.03em] tabular-nums select-none",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/20 rounded-lg",
          "antialiased transition-opacity duration-200",
          unset && !editing && "opacity-35"
        )}
      >
        {editing && (
          <input
            autoFocus
            type="text"
            inputMode={decimals > 0 ? "decimal" : "numeric"}
            enterKeyHint="done"
            aria-label={label}
            value={draft}
            placeholder="0"
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => finishEditing(true)}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") e.currentTarget.blur();
              else if (e.key === "Escape") {
                finishEditing(false);
              }
            }}
            className={cn(
              "absolute inset-0 z-10 w-full h-full rounded-lg bg-[#242427] text-center text-white",
              sm ? "text-[16px]" : "text-[22px]",
              "font-semibold tabular-nums outline-none ring-1 ring-white/25"
            )}
          />
        )}
        {Array.from({ length: PLACES }, (_, i) => {
          const p = PLACES - 1 - i;
          const isVisible = p < shownDigits;

          return (
            <React.Fragment key={p}>
              <div
                className={cn(
                  "relative overflow-hidden transition-all duration-200 ease-out",
                  isVisible ? "w-[0.59em] opacity-100" : "w-0 opacity-0 pointer-events-none"
                )}
                style={{ height: CELL_HEIGHT }}
              >
                <div
                  ref={(el) => {
                    strips.current[p] = el;
                  }}
                  className="flex flex-col items-center will-change-transform select-none"
                >
                  {DIGITS.map((digit, idx) => (
                    <span
                      key={idx}
                      className="flex items-center justify-center leading-none"
                      style={{ height: CELL_HEIGHT }}
                    >
                      {digit}
                    </span>
                  ))}
                </div>
              </div>

              {/* Decimal point */}
              {decimals > 0 && p === decimals && <span className="text-white/80 mx-[1px]">.</span>}

              {/* Thousands Delimiter */}
              {p === 3 + decimals && (
                <span
                  className={cn(
                    sm ? "text-sm" : "text-lg",
                    "text-neutral-400 transition-all duration-200 mx-[1px]",
                    shownDigits > 3 + decimals ? "w-auto opacity-100" : "w-0 opacity-0 overflow-hidden"
                  )}
                >
                  ,
                </span>
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* Plus Button */}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Increase value"
        disabled={disabled || activeValue >= maxU}
        onPointerDown={() => handleHoldStart(1)}
        onPointerUp={handleHoldEnd}
        onPointerLeave={handleHoldEnd}
        onPointerCancel={handleHoldEnd}
        className={cn(
          "flex items-center justify-center",
          sm ? "w-[30px] h-[30px] rounded-[10px]" : "w-[42px] h-[42px] rounded-[14px]",
          "bg-[#242427] text-neutral-300 border border-white/[0.05]",
          "hover:bg-[#2d2d31] hover:text-white hover:border-white/[0.1]",
          "active:scale-[0.96] active:bg-[#1e1e21]",
          "transition-all duration-150 ease-out select-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400",
          "disabled:opacity-30 disabled:pointer-events-none"
        )}
      >
        <Plus className={cn(sm ? "w-[14px] h-[14px]" : "w-[18px] h-[18px]", "stroke-[2.4]")} />
      </button>
    </div>
  );
}

export { RollingCounter as Component };
export default RollingCounter;
