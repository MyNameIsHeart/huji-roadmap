import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Planner, mergeGroups, offeredAt, nextOffered } from '../js/model.js';

const courses = JSON.parse(readFileSync(new URL('../data/courses.json', import.meta.url))).courses;
const math = JSON.parse(readFileSync(new URL('../data/roadmaps/530-1010.json', import.meta.url)));

const INFI1 = '80131', INFI2 = '80132', INFI3 = '80415', LA1 = '80134', LA2 = '80135', DISCRETE = '80181';

test('semester offering rules', () => {
  assert.equal(offeredAt({ period: 1 }, 0), true);
  assert.equal(offeredAt({ period: 1 }, 1), false);
  assert.equal(offeredAt({ period: 2 }, 0), false);
  assert.equal(offeredAt({ period: 3 }, 1), true);
  assert.equal(nextOffered({ period: 2 }, 0), 1);
  assert.equal(nextOffered({ period: 1 }, 1), 2);
});

test('required-elective groups repeated per year are merged', () => {
  const groups = mergeGroups([math]);
  const re = groups.filter(g => g.kind === 'required_elective' && g.courses.includes('80420'));
  assert.equal(re.length, 1);
  assert.deepEqual(re[0].years, [2, 3]);
  assert.equal(re[0].minPoints, 23);
});

test('fresh student: Infi 3 lands after Infi 2 and Linear Algebra 2', () => {
  const p = new Planner(courses, [math], { maxPoints: 25 });
  const r = p.schedule({ done: new Set(), pinned: new Map(), chosen: new Set() });
  assert.equal(r.plan.get(INFI1), 0);
  assert.equal(r.plan.get(LA1), 0);
  assert.equal(r.plan.get(INFI2), 1);
  assert.equal(r.plan.get(LA2), 1);
  assert.equal(r.plan.get(INFI3), 2);
  assert.ok(r.plan.get('80416') >= 3, 'analysis on manifolds needs Infi 3 first');
  assert.equal(r.warnings.size, 0, JSON.stringify([...r.warnings]));
  assert.ok(r.end >= 3, 'the required chain spans at least four semesters');
  const donePts = 0;
  const grad = p.estimateGraduation(r, 134, donePts);
  assert.ok(grad >= 5 && grad <= 7, `134 credits at 25 per semester lands in year 3-4, got ${grad}`);
});

test('postponing Infi 2 delays graduation, postponing discrete math does not', () => {
  const p = new Planner(courses, [math], { maxPoints: 25 });
  const input = { done: new Set(), pinned: new Map(), chosen: new Set() };
  const base = p.schedule(input);
  const sens = p.sensitivity(input, base);
  const infi2 = sens.get(INFI2);
  assert.ok(infi2.delay >= 1, `expected delay, got ${infi2.delay}`);
  assert.ok(infi2.pushed.includes(INFI3), 'Infi 3 is pushed');
  const discrete = sens.get(DISCRETE);
  assert.equal(discrete.delay, 0);
});

test('completed courses are skipped and unlock dependents immediately', () => {
  const p = new Planner(courses, [math], { maxPoints: 25 });
  const done = new Set([INFI1, INFI2, LA1, LA2, DISCRETE, '80111', '80116', '77154', '76408']);
  const r = p.schedule({ done, pinned: new Map(), chosen: new Set() });
  assert.equal(r.plan.has(INFI1), false);
  assert.equal(r.plan.get(INFI3), 0);
});

test('pinning a course before its prerequisite produces a warning', () => {
  const p = new Planner(courses, [math], { maxPoints: 25 });
  const r = p.schedule({ done: new Set(), pinned: new Map([[INFI3, 0]]), chosen: new Set() });
  const w = r.warnings.get(INFI3) || [];
  assert.ok(w.some(x => x.type === 'prereq'));
});

test('choosing an elective pulls in its prerequisites', () => {
  const p = new Planner(courses, [math], { maxPoints: 25 });
  // 80416 analysis on manifolds requires Infi 3 (or accelerated Infi 2)
  const r = p.schedule({ done: new Set(), pinned: new Map(), chosen: new Set(['80519']) });
  assert.ok(r.plan.has('80519'));
  const c = courses['80519'];
  if (c.prereq) {
    const w = r.warnings.get('80519') || [];
    assert.ok(!w.some(x => x.type === 'prereq'), JSON.stringify(w));
  }
});
