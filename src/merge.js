// ---------------------------------------------------------------------------
// 3-way merge — pure and backend-agnostic.
//
// base   = common ancestor (what the server had when we last loaded/saved)
// local  = our current board
// remote = the latest server version
//
// This lives ABOVE the storage backend on purpose: any backend only has to
// load and save documents; conflict resolution is handled here, so swapping
// backends keeps the same merge behavior for free.
// ---------------------------------------------------------------------------

export function clone(o) { return JSON.parse(JSON.stringify(o)); }
export function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

export function merge3(base, local, remote) {
  base = base || { groups: [], tasks: [], settings: {} };
  return {
    version: 1,
    settings: mergeFields(base.settings || {}, local.settings || {}, remote.settings || {}),
    groups: mergeList(base.groups || [], local.groups || [], remote.groups || []),
    tasks: mergeList(base.tasks || [], local.tasks || [], remote.tasks || [])
  };
}

function byId(arr) { const m = {}; for (const x of arr) m[x.id] = x; return m; }

function mergeFields(b, l, r) {
  const out = clone(l); const keys = new Set([...Object.keys(l), ...Object.keys(r)]);
  for (const k of keys) {
    const lc = !eq(b ? b[k] : undefined, l[k]);
    const rc = !eq(b ? b[k] : undefined, r[k]);
    if (rc && !lc) out[k] = clone(r[k]); // remote changed this field, we didn't → take theirs
    // otherwise keep local (covers we-changed and both-changed → ours wins)
  }
  return out;
}

function mergeList(base, local, remote) {
  const b = byId(base), l = byId(local), r = byId(remote);
  function resolve(id) {
    const inB = id in b, inL = id in l, inR = id in r;
    if (inL && inR) {
      if (!inB) return clone(l);                 // both added → ours
      const lc = !eq(b[id], l[id]), rc = !eq(b[id], r[id]);
      if (lc && !rc) return clone(l[id]);
      if (rc && !lc) return clone(r[id]);
      if (!lc && !rc) return clone(l[id]);
      return mergeFields(b[id], l[id], r[id]);   // both changed → field-level, ours wins ties
    }
    if (inB && !inL && inR) return eq(b[id], r[id]) ? undefined : clone(r[id]); // we deleted; keep only if they changed it
    if (inB && inL && !inR) return eq(b[id], l[id]) ? undefined : clone(l[id]); // they deleted; keep only if we changed it
    if (!inB && inL) return clone(l[id]);         // we added
    if (!inB && inR) return clone(r[id]);         // they added
    return undefined;
  }
  const out = [], seen = new Set();
  for (const x of local) { if (seen.has(x.id)) continue; seen.add(x.id); const v = resolve(x.id); if (v) out.push(v); }
  for (const x of remote) { if (seen.has(x.id)) continue; seen.add(x.id); const v = resolve(x.id); if (v) out.push(v); }
  return out;
}
