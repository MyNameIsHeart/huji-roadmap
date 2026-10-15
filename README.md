# HUJI Roadmap · מפת דרכים לתואר

A static degree planner for the Hebrew University, built from the official
[Shnaton](https://shnaton.huji.ac.il) catalog. Pick your track, mark what you
already passed, and see every remaining course laid out by semester with its
prerequisite chain. Drag a course to another semester and the plan reflows:
courses that depend on it move, and the projected end of the degree updates.

**Live site:** https://mynameisheart.github.io/huji-roadmap/

## What it does

- Loads the degree structure (mandatory / required-elective / elective groups
  per year) for one track, or two tracks for a dual major.
- Loads every course's prerequisite tree (AND / OR / minimum grade) and the
  courses it unlocks.
- Schedules the remaining mandatory courses as early as prerequisites and
  semester offerings allow, under a credits-per-semester cap, and fills
  required-elective groups with the courses that can be taken soonest.
- Shows, for every planned course, how many semesters later the degree would
  end if that course were postponed by one semester, and which courses it
  would push (the critical path is marked in red).
- Lets you pin courses to semesters by drag and drop, mark courses as
  completed, add electives, and share the plan as a link.

## Data

`scripts/fetch_shnaton.py` pulls the data from the Shnaton's JSON API and
writes it under `data/`:

| file | content |
| --- | --- |
| `data/index.json` | catalog year and the tracks that have data |
| `data/roadmaps/<code>.json` | requirement groups of one track |
| `data/courses.json` | every referenced course with its prerequisite tree |
| `data/all-roadmaps.json` | every bachelor track the Shnaton lists |

The tracks to fetch are listed in `data/roadmaps.txt`. To add one, find its
code in `data/all-roadmaps.json` (or in the Shnaton URL, e.g.
`shnaton.huji.ac.il/roadmap/530-1010`), add it to the list and run:

```bash
python3 scripts/fetch_shnaton.py
```

The `Refresh Shnaton data` workflow re-runs the script every Monday and
commits any change, so the site follows the current catalog.

## Development

No build step. Serve the folder with any static server:

```bash
python3 -m http.server 8787
```

Planner logic lives in `js/model.js` and is covered by tests:

```bash
node --test tests/*.test.mjs
```

## Deployment

The `Deploy to GitHub Pages` workflow publishes the repository root on every
push to `main`. In the repository settings, under **Pages**, set the source to
**GitHub Actions** once.

## Caveats

- Group-level rules in the Shnaton are free text ("choose 6 courses from this
  list over years 2-3"); the planner only uses the minimum credits of each
  group. Department-level prerequisites that the Shnaton does not list per
  course are not modelled.
- Credits-per-semester and total degree credits are settings; the Shnaton does
  not expose the degree total per track.
