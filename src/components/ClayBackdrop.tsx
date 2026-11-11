// Slowly drifting clay pebbles behind the store screens.
// Each pebble is its own GPU layer and only `transform` animates, so the page
// keeps 60 fps; shading is painted once (no blur filters). Hidden from screen
// readers and from pointer input; frozen when reduced motion is requested.
export function ClayBackdrop() {
  return (
    <div className="clay-bg" aria-hidden>
      {Array.from({ length: 6 }, (_, i) => (
        <i key={i} />
      ))}
    </div>
  );
}
