// ---------------------------------------------------------------------------
// One shared hover card.
//
// The rest of the app uses `title=` for static one-word hints, which is right
// for those. It can't do this job: the OS delay is ~1s, the box is unstyleable,
// and a task's hover content is several lines (name, dates, owner, checkpoints).
//
// ONE element is created lazily and reused, because the elements it describes —
// bars, dots, list rows — are destroyed and rebuilt on every render(). For the
// same reason hideTip() is exported and called at the top of a re-render: a
// hovered bar can vanish from under the cursor, and pointerleave never fires.
//
// Content comes from the caller as an HTML string (already escaped with esc()),
// so this module knows nothing about tasks.
// ---------------------------------------------------------------------------
import { S } from "../state.js";

const GAP = 14;   // offset from the cursor, so the card never sits under it
const EDGE = 8;   // keep this far from the viewport edge

let tip = null;
function card() {
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tip";
    document.body.appendChild(tip);
  }
  return tip;
}

// `content` is an HTML string, or a function returning one. Returning "" means
// "nothing to say" and shows nothing.
export function attachTip(target, content) {
  target.addEventListener("pointerenter", (e) => show(content, e));
  target.addEventListener("pointermove", (e) => {
    // Nested targets: a checkpoint dot lives INSIDE a bar that has its own tip.
    // pointermove bubbles, so without this the bar's card would immediately
    // replace the dot's. pointerenter/pointerleave don't bubble, and pointerdown
    // is deliberately left alone so grabbing a dot still drags the bar.
    e.stopPropagation();
    show(content, e);
  });
  target.addEventListener("pointerleave", hideTip);
  target.addEventListener("pointerdown", hideTip);
}

function show(content, e) {
  // Touch/pen: a card pinned under a finger is an obstruction, not a hint.
  if (e.pointerType && e.pointerType !== "mouse") return;
  // Mid-drag the pointer isn't hovering, it's working — and a card trailing a
  // moving bar is pure noise.
  if (S.dragging) { hideTip(); return; }
  const html = typeof content === "function" ? content() : content;
  if (!html) { hideTip(); return; }
  const t = card();
  if (t.dataset.html !== html) { t.innerHTML = html; t.dataset.html = html; }
  t.classList.add("show");
  place(t, e.clientX, e.clientY);
}

// Flip to the other side of the cursor rather than sliding along the edge, so
// the card never covers the thing being pointed at.
function place(t, x, y) {
  const w = t.offsetWidth, h = t.offsetHeight;
  let left = x + GAP, top = y + GAP;
  if (left + w > window.innerWidth - EDGE) left = x - GAP - w;
  if (top + h > window.innerHeight - EDGE) top = y - GAP - h;
  t.style.left = Math.max(EDGE, left) + "px";
  t.style.top = Math.max(EDGE, top) + "px";
}

export function hideTip() {
  if (tip) tip.classList.remove("show");
}

// A wheel scroll moves the chart under a fixed card without producing a single
// pointermove, so nothing else would ever take it down.
window.addEventListener("wheel", hideTip, { passive: true });
