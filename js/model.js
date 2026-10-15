// Pure planning logic: prerequisite trees, earliest-feasible semesters,
// greedy scheduling, critical-path sensitivity. No DOM access here.

export const MAX_SLOTS = 24; // 12 academic years, plenty for any plan

export function slotYear(slot) { return Math.floor(slot / 2); } // 0-based
export function slotSem(slot) { return slot % 2; }               // 0 = A, 1 = B

export function offeredAt(course, slot) {
  const p = course ? course.period : null;
  if (p === 1 || p === 5) return slot % 2 === 0; // semester A, or yearly (starts in A)
  if (p === 2) return slot % 2 === 1;            // semester B
  return true;                                   // A or B, summer, unknown
}

export function nextOffered(course, from) {
  let s = Math.max(0, from | 0);
  while (!offeredAt(course, s) && s < MAX_SLOTS) s++;
  return s;
}

export function treeLeaves(tree, acc = []) {
  if (!tree) return acc;
  if (tree.type === 'COURSE') acc.push(tree.code);
  else for (const c of tree.children) treeLeaves(c, acc);
  return acc;
}

// Edges (prereq -> course) with a flag saying whether the prerequisite sits
// under an OR node (an alternative) or is strictly required.
export function treeEdges(tree, underOr = false, acc = []) {
  if (!tree) return acc;
  if (tree.type === 'COURSE') acc.push({ code: tree.code, alt: underOr });
  else for (const c of tree.children) treeEdges(c, underOr || tree.type === 'OR', acc);
  return acc;
}

function overlap(a, b) {
  const A = new Set(a);
  let n = 0;
  for (const x of b) if (A.has(x)) n++;
  return n / Math.max(1, Math.min(a.length, b.length));
}

// Merge the groups of the selected roadmaps. The Shnaton repeats a
// "choose N from this list over years 2-3" group once per year with
// overlapping lists; those are folded into one requirement.
export function mergeGroups(roadmaps) {
  const out = [];
  const seenMandatory = new Set();
  for (const rm of roadmaps) {
    for (const g of rm.groups) {
      const courses = g.mandatory ? g.courses.filter(c => !seenMandatory.has(c)) : g.courses.slice();
      if (g.mandatory) courses.forEach(c => seenMandatory.add(c));
      if (!courses.length) continue;
      let target = null;
      if (!g.mandatory) {
        target = out.find(o => o.roadmap === rm.code && o.kind === g.kind && !o.mandatory
          && o.title.he === g.title.he && Math.min(o.courses.length, courses.length) >= 2
          && overlap(o.courses, courses) >= 0.5);
      }
      if (target) {
        for (const c of courses) if (!target.courses.includes(c)) target.courses.push(c);
        target.years = [...new Set([...target.years, ...(g.years || [g.year])])].sort();
        target.minPoints = Math.max(target.minPoints || 0, g.minPoints || 0);
        target.maxPoints = Math.max(target.maxPoints || 0, g.maxPoints || 0) || null;
        if (!target.note.he && g.note.he) target.note = g.note;
      } else {
        out.push({
          id: `${rm.code}:${g.id}`,
          roadmap: rm.code,
          roadmapName: rm.name,
          year: g.year,
          years: (g.years && g.years.length ? g.years : [g.year]).slice(),
          kind: g.kind,
          title: g.title,
          mandatory: !!g.mandatory,
          minPoints: g.minPoints || 0,
          maxPoints: g.maxPoints,
          maxCount: g.maxCount,
          note: g.note,
          courses,
        });
      }
    }
  }
  const kindOrder = { mandatory: 0, required_elective: 1, elective: 2, other: 3 };
  out.sort((a, b) => (a.year || 99) - (b.year || 99) || kindOrder[a.kind] - kindOrder[b.kind]);
  return out;
}

export class Planner {
  /**
   * @param {Object<string, Object>} courses  all known courses by code
   * @param {Object[]} roadmaps               selected roadmap objects
   * @param {{maxPoints?: number}} options
   */
  constructor(courses, roadmaps, options = {}) {
    this.courses = courses;
    this.roadmaps = roadmaps;
    this.maxPoints = options.maxPoints || 25;
    this.groups = mergeGroups(roadmaps);
    this.universe = new Set();
    this.required = new Set();
    this.groupOf = new Map();
    for (const g of this.groups) {
      for (const c of g.courses) {
        this.universe.add(c);
        if (!this.groupOf.has(c)) this.groupOf.set(c, g);
        if (g.mandatory) this.required.add(c);
      }
    }
    // dependents: code -> Set(codes in universe whose prereq tree mentions it)
    this.dependents = new Map();
    for (const code of this.universe) {
      const c = courses[code];
      if (!c) continue;
      for (const leaf of new Set(treeLeaves(c.prereq))) {
        if (!this.dependents.has(leaf)) this.dependents.set(leaf, new Set());
        this.dependents.get(leaf).add(code);
      }
    }
    this._tail = new Map();
  }

  course(code) { return this.courses[code] || { code, name: { he: code, en: code }, points: 0, period: null, stub: true }; }
  points(code) { return this.course(code).points || 0; }

  // Longest chain of dependents below a course (static, for tie-breaking).
  tail(code, visiting = new Set()) {
    if (this._tail.has(code)) return this._tail.get(code);
    if (visiting.has(code)) return 0;
    visiting.add(code);
    let best = 0;
    for (const d of this.dependents.get(code) || []) best = Math.max(best, 1 + this.tail(d, visiting));
    visiting.delete(code);
    this._tail.set(code, best);
    return best;
  }

  ancestors(code, acc = new Set()) {
    const c = this.courses[code];
    if (!c) return acc;
    for (const leaf of treeLeaves(c.prereq)) {
      if (!acc.has(leaf)) { acc.add(leaf); this.ancestors(leaf, acc); }
    }
    return acc;
  }

  descendants(code, acc = new Set()) {
    for (const d of this.dependents.get(code) || []) {
      if (!acc.has(d)) { acc.add(d); this.descendants(d, acc); }
    }
    return acc;
  }

  /**
   * Build a full schedule.
   * @param {{done: Set<string>, pinned: Map<string, number>, chosen: Set<string>}} input
   */
  schedule(input) {
    const done = input.done || new Set();
    const pinned = input.pinned || new Map();
    const chosen = input.chosen || new Set();
    const source = new Map(); // code -> why it is in the plan

    for (const c of this.required) if (!done.has(c)) source.set(c, 'required');
    for (const c of chosen) if (!done.has(c)) source.set(c, source.get(c) || 'chosen');
    for (const c of pinned.keys()) if (!done.has(c)) source.set(c, source.get(c) || 'chosen');

    // Fill "required elective" groups up to their minimum with the courses
    // that can be taken soonest, so the projected end is realistic.
    const suggested = new Set();
    for (const g of this.groups) {
      if (g.kind !== 'required_elective' || !g.minPoints) continue;
      let pts = 0;
      for (const c of g.courses) if (done.has(c) || source.has(c)) pts += this.points(c);
      if (pts >= g.minPoints) continue;
      const cands = g.courses.filter(c => !done.has(c) && !source.has(c) && this.courses[c] && this.courses[c].offered !== false);
      const est = new Map();
      for (const c of cands) est.set(c, this.estimateEarliest(c, done, pinned, source));
      cands.sort((a, b) => est.get(a) - est.get(b) || this.points(b) - this.points(a) || a.localeCompare(b));
      for (const c of cands) {
        if (pts >= g.minPoints) break;
        source.set(c, 'suggested');
        suggested.add(c);
        pts += this.points(c);
      }
    }

    // Pull in prerequisites that are not yet done or planned (implied).
    const missing = new Map(); // code -> external prerequisite codes
    let added = true;
    while (added) {
      added = false;
      for (const code of [...source.keys()]) {
        const c = this.courses[code];
        if (!c || !c.prereq) continue;
        const res = this.ensure(c.prereq, done, source, pinned);
        for (const leaf of res.add) {
          if (!source.has(leaf)) { source.set(leaf, 'implied'); added = true; }
        }
        if (res.missing.length) missing.set(code, res.missing);
      }
    }

    // Greedy list scheduling in order of earliest feasible semester.
    const plan = new Map(); // code -> slot
    const slotPoints = new Array(MAX_SLOTS).fill(0);
    for (const [code, slot] of pinned) {
      if (done.has(code)) continue;
      plan.set(code, slot);
      slotPoints[slot] += this.points(code);
    }
    const unplaced = new Set([...source.keys()].filter(c => !plan.has(c)));
    while (unplaced.size) {
      let best = null, bestT = Infinity;
      const memo = new Map();
      for (const code of unplaced) {
        const t = this.earliest(code, done, plan, unplaced, memo).t;
        if (t < bestT || (t === bestT && this.betterFirst(code, best))) { best = code; bestT = t; }
      }
      const course = this.course(best);
      let s = nextOffered(course, bestT);
      const pts = this.points(best);
      while (s < MAX_SLOTS - 1 && slotPoints[s] > 0 && slotPoints[s] + pts > this.maxPoints) s = nextOffered(course, s + 1);
      plan.set(best, s);
      slotPoints[s] += pts;
      unplaced.delete(best);
    }

    // Validate.
    const warnings = new Map();
    const warn = (code, w) => { if (!warnings.has(code)) warnings.set(code, []); warnings.get(code).push(w); };
    const allTaken = new Set([...done, ...plan.keys()]);
    for (const [code, slot] of plan) {
      const c = this.courses[code];
      if (!c) continue;
      if (!offeredAt(c, slot)) warn(code, { type: 'not_offered' });
      if (c.offered === false) warn(code, { type: 'not_taught' });
      if (c.prereq) {
        const ok = this.satisfiedAt(c.prereq, slot, done, plan);
        if (!ok) warn(code, { type: 'prereq', missing: this.unmetLeaves(c.prereq, slot, done, plan) });
      }
      if (c.blockedBy) {
        const clash = treeLeaves(c.blockedBy).filter(x => allTaken.has(x));
        if (clash.length) warn(code, { type: 'blocked', by: clash });
      }
      if (missing.has(code)) warn(code, { type: 'external', missing: missing.get(code) });
    }
    const slots = [];
    let end = -1;
    for (const [code, slot] of plan) end = Math.max(end, slot);
    for (let s = 0; s <= end; s++) {
      const codes = [...plan].filter(([, sl]) => sl === s).map(([c]) => c);
      slots.push({ slot: s, points: slotPoints[s], codes, over: slotPoints[s] > this.maxPoints });
    }

    const groupProgress = this.groups.map(g => {
      let donePts = 0, plannedPts = 0, doneCount = 0, plannedCount = 0;
      for (const c of g.courses) {
        if (done.has(c)) { donePts += this.points(c); doneCount++; }
        else if (plan.has(c)) { plannedPts += this.points(c); plannedCount++; }
      }
      return { group: g, donePts, plannedPts, doneCount, plannedCount };
    });

    return { plan, source, end, slots, warnings, groupProgress, suggested };
  }

  betterFirst(a, b) {
    if (!b) return true;
    const ta = this.tail(a), tb = this.tail(b);
    if (ta !== tb) return ta > tb;
    const pa = this.points(a), pb = this.points(b);
    if (pa !== pb) return pa > pb;
    return a < b;
  }

  // Which courses must be added so `tree` can be satisfied. For OR nodes the
  // cheapest (earliest) alternative inside the student's roadmaps wins.
  ensure(tree, done, source, pinned) {
    const sat = (n) => {
      if (n.type === 'COURSE') return done.has(n.code) || source.has(n.code);
      if (n.type === 'AND') return n.children.every(sat);
      return n.children.some(sat);
    };
    const add = [], missing = [];
    const walk = (n) => {
      if (sat(n)) return;
      if (n.type === 'COURSE') {
        if (this.universe.has(n.code) && this.courses[n.code] && this.courses[n.code].offered !== false) add.push(n.code);
        else missing.push(n.code);
        return;
      }
      if (n.type === 'AND') { n.children.forEach(walk); return; }
      // OR: pick the alternative with the smallest estimated earliest slot,
      // preferring alternatives that live inside the roadmaps.
      let best = null, bestT = Infinity;
      for (const ch of n.children) {
        const leaves = treeLeaves(ch);
        const inside = leaves.every(l => this.universe.has(l) && this.courses[l] && this.courses[l].offered !== false);
        if (!inside) continue;
        const t = Math.max(0, ...leaves.map(l => this.estimateEarliest(l, done, pinned, source)));
        if (t < bestT) { best = ch; bestT = t; }
      }
      if (best) walk(best); else missing.push(...treeLeaves(n));
    };
    walk(tree);
    return { add, missing };
  }

  // Rough earliest slot ignoring capacity, used for ranking alternatives.
  estimateEarliest(code, done, pinned, source, visiting = new Set()) {
    if (done.has(code)) return -1;
    if (pinned.has(code)) return pinned.get(code);
    if (visiting.has(code)) return MAX_SLOTS;
    visiting.add(code);
    const c = this.courses[code];
    let ready = 0;
    if (c && c.prereq) {
      const walk = (n) => {
        if (n.type === 'COURSE') {
          if (done.has(n.code)) return 0;
          if (!this.universe.has(n.code) && !source.has(n.code) && !pinned.has(n.code)) return 0; // external: ignore
          return this.estimateEarliest(n.code, done, pinned, source, visiting) + 1;
        }
        const vals = n.children.map(walk);
        return n.type === 'AND' ? Math.max(0, ...vals) : Math.min(...vals);
      };
      ready = walk(c.prereq);
    }
    visiting.delete(code);
    return nextOffered(c, ready);
  }

  // Earliest slot for `code` given done courses, already placed courses and
  // the set still to place (whose own earliest is computed recursively).
  earliest(code, done, plan, unplaced, memo, visiting = new Set()) {
    if (memo.has(code)) return memo.get(code);
    if (visiting.has(code)) return { t: 0 };
    visiting.add(code);
    const c = this.course(code);
    let ready = 0;
    if (c.prereq) {
      const walk = (n) => {
        if (n.type === 'COURSE') {
          if (done.has(n.code)) return 0;
          if (plan.has(n.code)) return plan.get(n.code) + 1;
          if (unplaced.has(n.code)) return this.earliest(n.code, done, plan, unplaced, memo, visiting).t + 1;
          return Infinity; // not available in this plan
        }
        const vals = n.children.map(walk);
        return n.type === 'AND' ? Math.max(0, ...vals) : Math.min(...vals);
      };
      ready = walk(c.prereq);
      if (!isFinite(ready)) ready = this.earliestIgnoringExternal(c.prereq, done, plan, unplaced, memo, visiting);
    }
    visiting.delete(code);
    const res = { t: nextOffered(c, ready) };
    memo.set(code, res);
    return res;
  }

  earliestIgnoringExternal(tree, done, plan, unplaced, memo, visiting) {
    const walk = (n) => {
      if (n.type === 'COURSE') {
        if (done.has(n.code)) return 0;
        if (plan.has(n.code)) return plan.get(n.code) + 1;
        if (unplaced.has(n.code)) return this.earliest(n.code, done, plan, unplaced, memo, visiting).t + 1;
        return 0;
      }
      const vals = n.children.map(walk);
      return n.type === 'AND' ? Math.max(0, ...vals) : Math.min(...vals);
    };
    return walk(tree);
  }

  satisfiedAt(tree, slot, done, plan) {
    if (!tree) return true;
    if (tree.type === 'COURSE') return done.has(tree.code) || (plan.has(tree.code) && plan.get(tree.code) < slot);
    if (tree.type === 'AND') return tree.children.every(ch => this.satisfiedAt(ch, slot, done, plan));
    return tree.children.some(ch => this.satisfiedAt(ch, slot, done, plan));
  }

  unmetLeaves(tree, slot, done, plan) {
    const out = [];
    const walk = (n) => {
      if (this.satisfiedAt(n, slot, done, plan)) return;
      if (n.type === 'COURSE') out.push(n.code);
      else if (n.type === 'AND') n.children.forEach(walk);
      else out.push(...treeLeaves(n));
    };
    walk(tree);
    return out;
  }

  /**
   * For every planned course: how many semesters later the plan would end if
   * that course were postponed by one semester (to its next offering), and
   * which other courses that would push.
   */
  sensitivity(input, base) {
    const out = new Map();
    for (const [code, slot] of base.plan) {
      const course = this.course(code);
      const later = nextOffered(course, slot + 1);
      const pinned = new Map(input.pinned);
      pinned.set(code, later);
      const alt = this.schedule({ ...input, pinned });
      const pushed = [];
      for (const [c, s] of alt.plan) {
        if (c !== code && base.plan.has(c) && s > base.plan.get(c)) pushed.push(c);
      }
      out.set(code, { delay: alt.end - base.end, pushed, newSlot: later });
    }
    return out;
  }

  /**
   * Earliest semester by which `targetPoints` credits can be reached when the
   * free capacity of every semester is filled with electives.
   * Returns the slot index, or -1 when the target is already met.
   */
  estimateGraduation(result, targetPoints, donePoints) {
    let have = donePoints;
    for (const s of result.slots) have += s.points;
    if (have >= targetPoints) return result.end;
    let remaining = targetPoints - have;
    let slot = 0;
    while (slot < MAX_SLOTS) {
      const used = result.slots[slot] ? result.slots[slot].points : 0;
      remaining -= Math.max(0, this.maxPoints - used);
      if (remaining <= 0) break;
      slot++;
    }
    return Math.max(result.end, slot);
  }

  // Visible prerequisite edges among done + planned courses.
  edges(done, plan) {
    const out = [];
    for (const code of plan.keys()) {
      const c = this.courses[code];
      if (!c || !c.prereq) continue;
      for (const e of treeEdges(c.prereq)) {
        if (done.has(e.code) || plan.has(e.code)) out.push({ from: e.code, to: code, alt: e.alt });
      }
    }
    return out;
  }
}
