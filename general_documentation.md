# HUJI Roadmap: General Documentation

For people and for Claude. Everything here describes what is actually in the repository as of 2026-10-15.

# Project Overview & Architecture

## Purpose

A static web app for planning a Hebrew University bachelor's degree. The student picks a track (or two tracks for a dual major), marks courses already passed, and the app lays out every remaining course by semester, draws prerequisite arrows, and reports how postponing any single course would delay the end of the degree. All data comes from the official catalog (the Shnaton, shnaton.huji.ac.il).

## Domain model

| Term | Meaning in this codebase |
| --- | --- |
| Roadmap (track) | One degree program as the Shnaton defines it, identified by a code such as `530-1010` (Mathematics, single major). File: `data/roadmaps/<code>.json`. |
| Group | A requirement block inside a roadmap: year, kind (`mandatory`, `required_elective`, `elective`, `other`), minimum and maximum credits, a note, and a list of course codes. |
| Course | A catalog entry keyed by its code as a string: bilingual name, credits (`points`), offering period, prerequisite tree, blocking tree, replacements, and an `offered` flag. File: `data/courses.json`. |
| Period | When a course is given: `1` semester A, `2` semester B, `3` A or B, `4` summer, `5` yearly, `null` unknown. |
| Prerequisite tree | Nested object of `{type: 'COURSE', code, minGrade?}`, `{type: 'AND', children}`, `{type: 'OR', children}`. `prereq` must hold before taking the course; `blockedBy` lists courses that exclude it. |
| Slot | A semester index in the plan: `0` is year 1 semester A, `1` is year 1 semester B, `2` is year 2 semester A, and so on. Even slots are A, odd slots are B. |
| Plan state | What the student decided: selected roadmaps, start year, credits cap per semester, target credits for the degree, `done` codes, `pinned` code to slot, `chosen` elective codes. |
| Schedule result | Output of the planner: `plan` (code to slot), `source` (why a course is in the plan: `required`, `chosen`, `suggested`, `implied`), `end` slot, per-slot credits, warnings, group progress. |

## Architectural pattern

Two stages with a static JSON boundary between them:

1. An offline data pipeline (`scripts/fetch_shnaton.py`, Python standard library) calls the Shnaton JSON API and writes normalised JSON under `data/`.
2. A browser app with no framework and no build step: a pure planning model (`js/model.js`) and an imperative renderer (`js/app.js`) that rebuilds the DOM from state on every change.

There is no server, no database and no authentication. GitHub Pages serves the repository root.

## Data flow

Offline:

```
Shnaton API  -> fetch_shnaton.py -> data/index.json, data/roadmaps/*.json, data/courses.json
```

In the browser:

```
page load -> fetch index.json + courses.json + selected roadmaps/*.json
          -> state (localStorage or URL hash, else defaults)
user action (drag, click, select) -> update(fn)
   -> fn mutates state
   -> recompute(): new Planner(courses, roadmaps) -> schedule(input) -> sensitivity(input, result)
   -> save(): localStorage
   -> render(): header, stats, catalog, board, sensitivity table
   -> drawArrows(): SVG overlay of prerequisite edges between visible cards
```

The planner itself:

1. Collect the courses to plan: mandatory courses of the selected roadmaps, chosen electives, pinned courses, minus completed ones.
2. Fill each `required_elective` group up to its minimum credits with the courses that can be taken soonest (`suggested`).
3. Pull in missing prerequisites from inside the roadmaps (`implied`); for an OR node the alternative with the earliest estimated slot wins.
4. Greedy list scheduling: repeatedly take the unplaced course with the smallest earliest feasible slot (ties: longest chain of dependents, then more credits), and place it in the first offered slot at or after that with free capacity under the credits cap. Pinned courses keep their slot.
5. Validate: prerequisite not met before the slot, course not offered in that semester, course not taught this year, blocked by another planned course, prerequisite outside the track, semester over the cap.
6. Sensitivity: for every planned course, re-run the schedule with that course pinned one offering later and report the change in the end slot and which courses moved.

## Directory tree

```
.
├── index.html                 page shell: header, stats, catalog, board, popover
├── css/style.css              all styling; light and dark via prefers-color-scheme; RTL aware
├── js/
│   ├── app.js                 entry point: state, persistence, rendering, drag and drop, arrows, popover
│   ├── model.js               pure planner: Planner class, mergeGroups, offeredAt, tree helpers
│   ├── i18n.js                he/en string tables, t(), name(), setLang()
│   └── hebrew.js              Hebrew year label (2027 -> תשפ"ז)
├── data/
│   ├── roadmaps.txt           which track codes to fetch (one per line, # comments)
│   ├── index.json             catalog year, fetch time, period names, tracks with data
│   ├── courses.json           every referenced course with prerequisite trees (499 courses)
│   ├── all-roadmaps.json      every bachelor track the Shnaton lists (381), for discovery only
│   └── roadmaps/<code>.json   one file per fetched track (19 files)
├── scripts/fetch_shnaton.py   data pipeline
├── tests/model.test.mjs       planner tests against the real math track data
├── .github/workflows/
│   ├── pages.yml              deploy repository root to GitHub Pages on push to main
│   └── update-data.yml        weekly data refresh, runs tests, commits data/
├── .claude/launch.json        "site" preview: python3 -m http.server 8787
├── .nojekyll                  keep GitHub Pages from running Jekyll
├── README.md                  public description and usage
├── general_documentation.md   this file
├── claude_rules.md            working rules for the assistant (gitignored)
└── ideas.md                   owner's idea list (gitignored)
```

Boundaries: `model.js` never touches the DOM or `fetch`; `app.js` never computes schedules itself; `fetch_shnaton.py` is the only writer of `data/`.

# Tech Stack & Environment

## Runtime and languages

| Layer | Technology | Version notes |
| --- | --- | --- |
| Browser app | HTML, CSS, JavaScript ES modules | Needs a browser with ES2020 modules, `color-mix()` in CSS and the HTML5 drag and drop API. No transpilation. |
| Tests | Node.js built-in test runner (`node:test`, `node:assert/strict`) | Developed with Node 26.7; Node 20 or newer is enough. |
| Data pipeline | Python 3 standard library only (`urllib`, `json`, `concurrent.futures`) | Runs on 3.9 locally and 3.12 in CI. |
| Hosting | GitHub Pages via GitHub Actions | `actions/checkout@v4`, `actions/configure-pages@v5`, `actions/upload-pages-artifact@v3`, `actions/deploy-pages@v4`, `actions/setup-python@v5`. |

There is no `package.json`, no `requirements.txt`, no lockfile and no database.

## External dependency: the Shnaton API

Base URL `https://shnaton.huji.ac.il/api`. Open, unauthenticated, but it sends no CORS headers, so it is only called from the Python script. Endpoints used:

| Endpoint | Used for |
| --- | --- |
| `GET /reference-data/active-years` | current catalog year |
| `GET /learning-programs/1/yearly-roadmaps?year=Y` | list of all bachelor tracks |
| `GET /yearly-roadmaps/{code}/thresholds?activeYear=Y&thresholdYear=Y&include=0` | the groups and courses of one track |
| `GET /yearly-roadmaps/{code}/combinations?year=Y` | tracks a dual-major track can be combined with |
| `GET /courses/code/{code}?year=Y` | basic details of a course referenced only inside a prerequisite tree |
| `GET /courses/code/{code}/requirements?year=Y` | `positiveRequirements` and `negativeRequirements` as JSON strings |
| `GET /courses/code/{code}/replacements?year=Y` | replacement courses per track |

## Environment

No environment variables. Local prerequisites: `python3`, `node` (for tests), and any static file server for the UI. The `update-data.yml` workflow uses the default `GITHUB_TOKEN` with `contents: write` to commit refreshed data.

# Architecture Decision Records (ADRs) & Trade-offs

## ADR 1: Pre-fetched JSON instead of live API calls

Decision: the browser never calls the Shnaton; the Python script writes static JSON that is committed. Alternatives: calling the API from the page (impossible, no CORS headers) or a small proxy such as a Cloudflare Worker (rejected to keep the project free of servers and keys). Trade-off: data can lag the catalog, mitigated by the weekly refresh workflow and `fetchedAt` in `index.json`.

## ADR 2: Only the tracks listed in `data/roadmaps.txt` are fetched

Decision: 19 tracks are seeded (mathematics, computer science, physics, statistics, economics and AI combinations). Fetching all 381 bachelor tracks would mean tens of thousands of requests per refresh. Trade-off: adding a track is a one-line edit plus a script run.

## ADR 3: Vanilla JavaScript, no framework, no bundler

Decision: ES modules loaded directly by `index.html`; the whole UI is rebuilt from state on every change. Alternatives considered: React or Svelte with a build step. Rejected because the app is about 1,400 lines, GitHub Pages serves plain files, and a build step would add tooling to a repository that otherwise needs none. Trade-off: rendering is a full DOM rebuild, which is fine at this size but would need care if the catalog view grew to thousands of rows.

## ADR 4: Custom SVG arrow overlay on an HTML board instead of a graph library

Decision: the board is HTML columns (one per semester) with draggable cards; prerequisite edges are drawn in an absolutely positioned SVG using card bounding boxes. Alternatives: Cytoscape, D3 force or dagre layouts. Rejected because the layout dimension (semester) is already given by the plan, native HTML5 drag and drop stays available, and no dependency is needed. Trade-off: arrows are redrawn on scroll and resize, and long edges cross intermediate columns.

## ADR 5: Greedy scheduling plus brute-force sensitivity instead of an optimiser

Decision: `Planner.schedule` is a deterministic greedy list scheduler; the "what if I postpone this" numbers come from re-running the schedule once per planned course. Alternatives: integer programming or a critical-path method over the DAG with slack. Rejected because OR prerequisites, capacity limits and semester parity make the exact method awkward, while the input is about 100 courses and a full re-run takes milliseconds. Trade-off: the schedule is good, not provably optimal, and "delay" means "postponed to the next offering", which is two slots for a course given only in one semester.

## ADR 6: Merging repeated requirement groups

Decision: `mergeGroups` folds groups of the same track, kind and title whose course lists overlap by at least half (with at least two courses in the smaller list) into one group spanning both years. Reason: the Shnaton lists "take 6 courses from this list over years 2 and 3" once under year 2 and again under year 3; treating them separately would double the requirement. Trade-off: a heuristic; a false merge would under-count a requirement.

## ADR 7: Semesters are A and B only

Decision: a slot is either semester A or semester B; summer courses are treated as "any semester" and yearly courses as starting in A. Reason: summer and yearly offerings are rare in the seeded tracks (3 and 9 courses out of 499). Trade-off: a summer course lands in a regular column.

## ADR 8: Required-elective groups are satisfied by minimum credits only

Decision: free-text rules such as "choose 6 courses" or "at most one course from another department" are shown as notes and not enforced; only `minPoints` drives the automatic suggestions. Reason: the Shnaton exposes these rules only as Hebrew prose.

## ADR 9: Degree total and credits cap are user settings

Decision: defaults of 134 credits for the degree and 25 per semester, both editable. Reason: the Shnaton API returns no total for a track (`academicInfo` is empty) and students differ in load.

## ADR 10: Plan state in localStorage and in the URL

Decision: the plan is saved under `huji-roadmap:v1` in localStorage and can be encoded as base64url JSON in the URL hash (`#s=`) for sharing. Alternative: a backend with accounts, rejected to stay static. Trade-off: no sync between devices beyond pasting the link.

## ADR 11: Hebrew first, English available

Decision: the interface defaults to Hebrew and right-to-left; every string exists in both languages in `js/i18n.js`, and course names come from the catalog in both. Reason: the catalog and the students are Hebrew-speaking; English keeps the data readable for others.

## ADR 12: Standard-library-only Python

Decision: no `requests`, no `aiohttp`. Reason: the script must run in CI and on any machine with just `python3`, with no install step. Trade-off: hand-written retry loop and thread pool.

# Development Workflows & Canonical Commands

## Setup

Nothing to install. Clone the repository and you can run the site and the tests.

## Fetch or refresh data

All tracks in `data/roadmaps.txt`:

```bash
python3 scripts/fetch_shnaton.py
```

Specific tracks, a specific catalog year, or more parallel requests:

```bash
python3 scripts/fetch_shnaton.py 530-1010 521-8014 --year 2027 --workers 6
```

Re-runs are cheap: prerequisite data already in `data/courses.json` for the same year is reused. To add a track, find its code in `data/all-roadmaps.json` or in a Shnaton URL (`shnaton.huji.ac.il/roadmap/530-1010`), add a line to `data/roadmaps.txt`, run the script.

## Run locally

```bash
python3 -m http.server 8787
```

Then open http://localhost:8787/. Inside Claude Code the same server is the "site" entry in `.claude/launch.json`. A plain `file://` open does not work because the app uses `fetch` for the JSON.

## Quality checks

No linter, formatter or type checker is configured. Syntax check of a module:

```bash
node --check js/app.js
```

## Tests

Full suite:

```bash
node --test tests/*.test.mjs
```

Single file:

```bash
node --test tests/model.test.mjs
```

Watch mode:

```bash
node --test --watch tests/*.test.mjs
```

Coverage:

```bash
node --test --experimental-test-coverage tests/*.test.mjs
```

The tests load the real `data/courses.json` and `data/roadmaps/530-1010.json`, so a data refresh can legitimately change them; the refresh workflow runs the tests before committing.

## Build and release

There is no build. Pushing to `main` triggers `pages.yml`, which uploads the repository root and deploys it. One-time setting in the repository: Settings, Pages, Source = GitHub Actions. The data workflow runs every Monday at 03:00 UTC or on demand (Actions, "Refresh Shnaton data", Run workflow) and commits as `github-actions[bot]` only when `data/` changed.

# Code Style, Conventions & Guardrails

## Naming and organisation

- Files and data: lowercase, hyphenated (`all-roadmaps.json`, `update-data.yml`, `fetch_shnaton.py` uses underscores as Python convention).
- JavaScript: camelCase identifiers, `PascalCase` for the one class (`Planner`), `UPPER_SNAKE` for module constants (`MAX_SLOTS`, `STORAGE_KEY`).
- Python: snake_case functions, `UPPER_SNAKE` constants, `main()` guarded by `if __name__ == "__main__"`.
- One module per concern: `model.js` (pure logic), `app.js` (DOM and state), `i18n.js` (strings), `hebrew.js` (calendar). New planning logic goes in `model.js`; new UI goes in `app.js`.
- DOM is built with the `el(tag, attrs, ...children)` helper in `app.js`, never with `innerHTML` from data.
- Every user-visible string goes through `t(key)`; bilingual objects (`{he, en}`) are read with `name(obj)`.
- 2-space indentation, single quotes, semicolons, `const` by default.

## Typing and data validation

- No TypeScript. Data shapes are documented in the domain model table above and enforced at the boundary by `fetch_shnaton.py` (`lean_course`, `parse_tree`, `lean_name`).
- Course codes are strings everywhere. The script converts the Shnaton's numeric `courseCode` values; the app compares with `===` and uses codes as object keys.
- The app tolerates a missing course: `course(code)` in `app.js` and `Planner.course()` return a stub with the code as its name rather than throwing.
- Requirement trees are normalised at fetch time: single-child AND/OR nodes are collapsed, empty nodes dropped, raw JSON strings parsed.

## Error handling and logging

- Browser: a failed data fetch renders a `.error` block with the message; `localStorage` reads and writes are wrapped in `try/catch` so private mode works; clipboard failure falls back to a `prompt` with the link.
- Script: each request retries three times with back-off; HTTP 400 and 404 are treated as "no data" and the track is skipped with a message on stderr; progress goes to stdout.
- No logging framework and no analytics in the page.

## Anti-patterns (DO NOT)

1. Do not edit anything under `data/` by hand. Change `scripts/fetch_shnaton.py` or `data/roadmaps.txt` and re-run the script; hand edits are overwritten by the weekly workflow.
2. Do not call the Shnaton API from browser code. It has no CORS headers and GitHub Pages has no server to proxy through.
3. Do not add a `package.json`, a bundler, npm dependencies or CDN scripts. The site must keep working as plain files served from the repository root.
4. Do not put DOM access, `fetch` or `localStorage` into `js/model.js`. It must stay testable from Node with plain objects, Sets and Maps.
5. Do not change state outside `update(fn)` in `app.js`. Every change must go through recompute, save and render, or the board, arrows and stored plan drift apart.
6. Do not treat course codes as numbers or mix `80131` with `'80131'`; prerequisite trees and group lists use strings.
7. Do not add a user-facing string to only one language table in `js/i18n.js`.
8. Do not mark a planning change as done without a test in `tests/` and a passing `node --test tests/*.test.mjs`.
9. Do not use em dashes in any text in this repository.
