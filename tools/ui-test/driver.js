// ---------------------------------------------------------------------------
// Screenshot driver. Runs inside the real index.html in place of src/main.js,
// exactly like suite.js does, but instead of asserting it puts ONE surface on
// screen and holds it there for shot.mjs to photograph.
//
// Which surface comes from ?shot=<name> on the page URL. The theme is NOT set
// from here — shot.mjs stamps data-theme onto <html> in the served markup,
// which is deterministic in a way localStorage juggling is not.
// ---------------------------------------------------------------------------
import { $, setup, MEMBERS, calls } from "./harness.js";

const which = new URL(location.href).searchParams.get("shot") || "gate";

// The veil is `show` in the shipped markup and session.js normally lowers it.
// Nothing starts a session here, so lower it by hand or every shot is a blank
// "Loading board…" panel.
function unveil() { const el = $("loading"); if (el) el.classList.remove("show"); }

function peopleHandlers(extra) {
  return Object.assign({
    loadMembers: async () => MEMBERS.map((m) => ({ ...m })),
    onSetRole: (email, role) => { calls.push(["setRole", email, role]); },
    onRemoveMember: (email) => { calls.push(["removeMember", email]); },
    onOpenInvite: () => { calls.push(["openInvite"]); }
  }, extra || {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- a board with owners and checkpoints on it -----------------------------
// Dates are relative to TODAY, because half of what these shots have to prove
// is date-derived: a checkpoint before today is filled, after today is hollow,
// and outside the task's span is dimmed and pinned to the capsule's edge.
async function seedBoard() {
  await setup("admin");
  // setup() opens a workspace but never runs a session, and the gate is `show`
  // in the shipped markup — so without this the board is photographed through it.
  (await import("../../src/ui/gate.js")).hideGate();
  const { S, normalize } = await import("../../src/state.js");
  const { render } = await import("../../src/render/index.js");
  const { today, fmtD, addDays } = await import("../../src/dates.js");
  const d = (n) => fmtD(addDays(today(), n));
  S.state = normalize({
    version: 1,
    settings: { viewMode: "week" },
    groups: [
      { id: "g1", name: "Planning", color: "#5c9ded" },
      { id: "g2", name: "Build", color: "#7fb069" }
    ],
    tasks: [
      // A long name with an early checkpoint: the dot lands UNDER the label, so
      // this row is what proves the label/dot bands don't fight.
      { id: "t1", name: "Discovery & stakeholder interviews", groupId: "g1",
        start: d(-24), end: d(-4),
        owner: "Dana Cohen", checkpoints: [
          { id: "c1", date: d(-18), label: "Interviews done" },
          { id: "c2", date: d(-9), label: "Findings review" }
        ] },
      { id: "t2", name: "Spec & design", groupId: "g1", start: d(-10), end: d(18),
        owner: "Yael", color: "#a78bda", checkpoints: [
          { id: "c3", date: d(-5), label: "Design freeze" },
          { id: "c4", date: d(7), label: "Copy review" },
          { id: "c5", date: d(26), label: "Stakeholder sign-off" }
        ] },
      // a PARENT task (t4/t5 nest under it): its dates roll up, but a checkpoint
      // of its own is still allowed, and its dot has to read against the pale
      // tinted frame rather than a solid pill
      { id: "t3", name: "Launch readiness", groupId: "g2", start: d(2), end: d(30),
        owner: "Matan", checkpoints: [{ id: "c7", date: d(21), label: "Go/no-go" }] },
      { id: "t4", name: "API", groupId: "g2", parentId: "t3", start: d(2), end: d(14),
        owner: "Matan", checkpoints: [{ id: "c6", date: d(9), label: "Contract frozen" }] },
      { id: "t5", name: "Rollout", groupId: "g2", parentId: "t3", start: d(15), end: d(30),
        owner: "Guy", checkpoints: [] },
      { id: "t6", name: "Public beta", groupId: "g2", start: d(32), end: d(32),
        isMilestone: true, owner: "Guy", checkpoints: [] }
    ]
  });
  render();
  return S;
}

// Show the hover card. attachTip listens for real pointer events and ignores
// anything that isn't pointerType "mouse", so the synthetic ones have to say so.
function hover(el) {
  const r = el.getBoundingClientRect();
  const at = { pointerType: "mouse", clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true };
  el.dispatchEvent(new PointerEvent("pointerenter", at));
  el.dispatchEvent(new PointerEvent("pointermove", at));
}

// --- the surfaces ----------------------------------------------------------
const SHOTS = {
  // The signed-out gate. Deliberately does NOT call startSession(): that would
  // reach Firebase Auth for real, and the shot must not depend on the network.
  async gate() {
    const gate = await import("../../src/ui/gate.js");
    gate.wireGate({ onSignIn() {}, onSignOut() {}, onRefresh() {} });
    gate.showGate("signin");
    unveil();
  },

  // The gate's "you're in no workspace" branch, which carries the footer row.
  async gateEmpty() {
    const gate = await import("../../src/ui/gate.js");
    gate.wireGate({ onSignIn() {}, onSignOut() {}, onRefresh() {} });
    gate.showGate("empty", { email: "guy@korro.ai" });
    unveil();
  },

  // The workspace panel with the invite dialog on top of it — the whole point
  // of the stacking fix, so the shot has to show both at once.
  async invite() {
    await setup("admin");
    const panel = await import("../../src/ui/panel.js");
    panel.wirePanel(peopleHandlers({ onOpenInvite: () => panel.openInvite() }));
    panel.renderPanel();
    panel.openPanel();
    await sleep(150);          // let the roster land and the slide-over settle
    panel.openInvite();
    unveil();
  },

  // The chart, with checkpoint dots in every capsule and no hover card in the
  // way — including a dot on a parent bar, which wears its frame colour rather
  // than the --panel ring a solid pill gets.
  async board() {
    await seedBoard();
    unveil();
  },

  // The same chart with the hover card open on the task that has all three dot
  // states: passed, still ahead, and outside the task's own dates.
  async boardHover() {
    await seedBoard();
    unveil();
    await sleep(60);
    const bar = document.querySelector('.bar[data-id="t2"]');
    if (bar) hover(bar);
  },

  // The same board in Tasks view, where checkpoints become chips and the owner
  // gets a chip of its own.
  async boardTasks() {
    await seedBoard();
    const { setViewTab } = await import("../../src/ui/toolbar.js");
    setViewTab("tasks");   // also sets body.tasks-view, which reveals the pane
    unveil();
  },

  // The editor with the Owner field and the checkpoint rows, including the
  // out-of-range hint (t2's last checkpoint sits past its end date).
  async editor() {
    await seedBoard();
    const { openEditor } = await import("../../src/ui/editor.js");
    openEditor("t2");
    unveil();
    await sleep(60);
  }
};

await (SHOTS[which] || SHOTS.gate)();

// Tell shot.mjs the surface is up. Chrome's own --screenshot fires on load and
// would catch a half-built page; shot.mjs waits for this instead.
try { await fetch("/ready?shot=" + encodeURIComponent(which)); } catch (_) {}
