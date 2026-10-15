#!/usr/bin/env python3
"""Fetch degree roadmaps and course prerequisites from the HUJI Shnaton API.

Usage:
    python3 scripts/fetch_shnaton.py                # roadmaps listed in data/roadmaps.txt
    python3 scripts/fetch_shnaton.py 530-1010 ...   # specific roadmap codes
    python3 scripts/fetch_shnaton.py --year 2026    # a specific catalog year

Writes:
    data/index.json            catalog year + the roadmaps that have data
    data/all-roadmaps.json     every bachelor roadmap the Shnaton knows (for discovery)
    data/roadmaps/<code>.json  degree structure (requirement groups per year)
    data/courses.json          every course referenced, with prerequisite trees

Only the Python standard library is used.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

API = "https://shnaton.huji.ac.il/api"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
HEADERS = {
    "Accept": "application/json",
    "User-Agent": "huji-roadmap data fetcher (https://github.com/MyNameIsHeart/huji-roadmap)",
}


def get(path, params=None, retries=3):
    url = API + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):
                return None
            if attempt == retries - 1:
                raise
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            if attempt == retries - 1:
                raise
        time.sleep(1.5 * (attempt + 1))


def lean_name(obj):
    if not obj:
        return {"he": "", "en": ""}
    return {"he": (obj.get("he") or "").strip(), "en": (obj.get("en") or "").strip()}


def parse_tree(raw):
    """Requirement trees arrive as a JSON string; normalise to a compact tree."""
    if not raw:
        return None
    try:
        tree = json.loads(raw) if isinstance(raw, str) else raw
    except json.JSONDecodeError:
        return None

    def walk(node):
        t = node.get("type")
        if t == "COURSE":
            out = {"type": "COURSE", "code": str(node.get("courseCode"))}
            if node.get("minGrade"):
                out["minGrade"] = node["minGrade"]
            if node.get("courseName"):
                out["name"] = lean_name(node["courseName"])
            return out
        children = [walk(c) for c in node.get("children", [])]
        children = [c for c in children if c]
        if not children:
            return None
        if len(children) == 1:
            return children[0]
        return {"type": t, "children": children}

    return walk(tree)


def tree_codes(tree, acc):
    if not tree:
        return acc
    if tree["type"] == "COURSE":
        acc.add(tree["code"])
    else:
        for c in tree["children"]:
            tree_codes(c, acc)
    return acc


def tree_names(tree, acc):
    if not tree:
        return acc
    if tree["type"] == "COURSE":
        if tree.get("name"):
            acc[tree["code"]] = tree["name"]
    else:
        for c in tree["children"]:
            tree_names(c, acc)
    return acc


KIND_BY_SUBCHAPTER = {
    "חובה": "mandatory",
    "חובת בחירה": "required_elective",
    "בחירה": "elective",
    "קורסים נוספים": "other",
}


def lean_course(c):
    period_name = lean_name(c.get("coursePeriodName"))
    return {
        "code": str(c["code"]),
        "name": lean_name(c.get("name")),
        "points": c.get("academicPoints") or 0,
        "period": c.get("coursePeriod"),
        "periodName": period_name,
        "department": lean_name(c.get("departmentName")),
        "faculty": lean_name(c.get("facultyName")),
        "offered": bool(c.get("isLearning")),
        "year": c.get("year"),
    }


def fetch_roadmap(code, year):
    rm = get(f"/yearly-roadmaps/{code}/thresholds",
             {"activeYear": year, "thresholdYear": year, "include": 0})
    if not rm:
        print(f"  !! roadmap {code}: no data for {year}", file=sys.stderr)
        return None, {}
    courses = {}
    groups = []
    for t in rm.get("thresholds") or []:
        if t.get("notIncludeInShnaton"):
            continue
        sub = (t.get("subChapter") or {}).get("he", "").strip()
        kind = KIND_BY_SUBCHAPTER.get(sub, "other")
        codes = []
        for c in t.get("courses") or []:
            lc = lean_course(c)
            courses[lc["code"]] = lc
            codes.append(lc["code"])
        if not codes:
            continue
        groups.append({
            "id": t.get("id"),
            "year": t.get("displayAcademicYear"),
            "years": t.get("fromToAcademicYear") or [],
            "kind": kind,
            "title": lean_name(t.get("subChapter")),
            "mandatory": bool(t.get("isMandatory")),
            "minPoints": t.get("minNaz"),
            "maxPoints": t.get("maxNaz"),
            "maxCount": t.get("maxCourseCount"),
            "note": {"he": (t.get("hebrewNote") or "").strip(" ."),
                     "en": (t.get("englishNote") or "").strip(" .")},
            "order": t.get("subChapterOrder"),
            "courses": codes,
        })
    groups.sort(key=lambda g: (g["year"] or 99, 0 if g["mandatory"] else 1, g["order"] or 0))

    combos = get(f"/yearly-roadmaps/{code}/combinations", {"year": year}) or []
    combinations = [{
        "code": x["combinedRoadmap"]["code"],
        "name": lean_name(x["combinedRoadmap"]["name"]),
    } for x in combos if x.get("combinedRoadmap")]

    out = {
        "code": code,
        "name": lean_name((rm.get("roadmap") or {}).get("name")),
        "scope": lean_name(rm.get("scopeName")),
        "degree": (rm.get("diplomaDegreeTypeName") or {}).get("en", "").strip(". "),
        "department": lean_name(rm.get("departmentName")),
        "departmentId": rm.get("departmentId"),
        "faculty": lean_name(rm.get("facultyName")),
        "year": year,
        "groups": groups,
        "combinations": combinations,
    }
    return out, courses


def fetch_course_extras(code, year):
    req = get(f"/courses/code/{code}/requirements", {"year": year}) or {}
    rep = get(f"/courses/code/{code}/replacements", {"year": year}) or []
    prereq = parse_tree(req.get("positiveRequirements"))
    blocked = parse_tree(req.get("negativeRequirements"))
    replacements = []
    for r in rep:
        tree = parse_tree(r.get("parsedReplacements"))
        if tree:
            replacements.append({
                "roadmap": lean_name(r.get("roadmapName")),
                "courses": sorted(tree_codes(tree, set())),
                "names": tree_names(tree, {}),
            })
    return code, {
        "prereq": prereq,
        "blockedBy": blocked,
        "additionalRequirements": bool(req.get("additionalRequirements")),
        "replacements": replacements,
    }


def fetch_course_basic(code, year):
    rows = get(f"/courses/code/{code}", {"year": year}) or []
    if not rows:
        return code, None
    return code, lean_course(rows[0])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("codes", nargs="*", help="roadmap codes, e.g. 530-1010")
    ap.add_argument("--year", type=int, help="catalog year (default: current)")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    years = get("/reference-data/active-years") or []
    current = next((y for y in years if y.get("current")), years[0] if years else None)
    year = args.year or (current or {}).get("year")
    hebrew_year = next((y["hebrewYear"] for y in years if y["year"] == year), "")
    print(f"catalog year {year} ({hebrew_year})")

    codes = args.codes
    if not codes:
        with open(os.path.join(DATA, "roadmaps.txt"), encoding="utf-8") as f:
            codes = [l.split("#")[0].strip() for l in f if l.split("#")[0].strip()]

    os.makedirs(os.path.join(DATA, "roadmaps"), exist_ok=True)

    all_rm = get("/learning-programs/1/yearly-roadmaps", {"year": year}) or []
    lean_all = sorted([{
        "code": r["roadmapCode"],
        "name": lean_name((r.get("roadmap") or {}).get("name")),
        "scope": lean_name(r.get("scopeName")),
        "department": lean_name(r.get("departmentName")),
        "departmentId": r.get("departmentId"),
    } for r in all_rm], key=lambda r: r["name"]["he"])
    with open(os.path.join(DATA, "all-roadmaps.json"), "w", encoding="utf-8") as f:
        json.dump({"year": year, "roadmaps": lean_all}, f, ensure_ascii=False, indent=0)
    print(f"{len(lean_all)} bachelor roadmaps listed")

    # Reuse previously fetched courses so re-runs are cheap and stubs keep names.
    courses_path = os.path.join(DATA, "courses.json")
    courses = {}
    if os.path.exists(courses_path):
        with open(courses_path, encoding="utf-8") as f:
            old = json.load(f)
            if old.get("year") == year:
                courses = old.get("courses", {})

    roadmaps_meta = []
    needed = set()
    for code in codes:
        print(f"roadmap {code} ...")
        rm, rm_courses = fetch_roadmap(code, year)
        if not rm:
            continue
        for c, lc in rm_courses.items():
            entry = courses.setdefault(c, {})
            entry.update(lc)
            entry.pop("stub", None)
            needed.add(c)
        with open(os.path.join(DATA, "roadmaps", f"{code}.json"), "w", encoding="utf-8") as f:
            json.dump(rm, f, ensure_ascii=False, indent=1)
        mand = sum(len(g["courses"]) for g in rm["groups"] if g["mandatory"])
        print(f"  {rm['name']['he']}: {len(rm['groups'])} groups, {len(rm_courses)} courses ({mand} mandatory)")
        roadmaps_meta.append({k: rm[k] for k in ("code", "name", "scope", "degree", "department", "departmentId")})

    todo = sorted(c for c in needed if "prereq" not in courses.get(c, {}))
    print(f"fetching prerequisites for {len(todo)} courses ...")
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for i, (code, extras) in enumerate(ex.map(lambda c: fetch_course_extras(c, year), todo), 1):
            courses[code].update(extras)
            if i % 50 == 0:
                print(f"  {i}/{len(todo)}")

    # Courses referenced only inside prerequisite trees: keep a named stub so the
    # graph can show them, and fetch their basic details (points, semester).
    referenced = {}
    for c in list(courses.values()):
        tree_names(c.get("prereq"), referenced)
        tree_names(c.get("blockedBy"), referenced)
        for r in c.get("replacements", []):
            referenced.update(r.get("names", {}))
    stubs = sorted(code for code in referenced if "name" not in courses.get(code, {}))
    print(f"fetching details for {len(stubs)} referenced courses ...")
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for code, basic in ex.map(lambda c: fetch_course_basic(c, year), stubs):
            entry = courses.setdefault(code, {})
            if basic:
                entry.update(basic)
            else:
                entry.update({"code": code, "name": referenced[code], "points": 0,
                              "period": None, "periodName": {"he": "", "en": ""}, "offered": False})
            entry["stub"] = True

    for c in courses.values():
        c.pop("names", None)
        for r in c.get("replacements", []):
            r.pop("names", None)

    with open(courses_path, "w", encoding="utf-8") as f:
        json.dump({"year": year, "courses": dict(sorted(courses.items()))}, f, ensure_ascii=False, indent=0)

    periods = {}
    for c in courses.values():
        if c.get("period") is not None:
            periods[str(c["period"])] = c.get("periodName")
    index = {
        "year": year,
        "hebrewYear": hebrew_year,
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "periods": periods,
        "roadmaps": roadmaps_meta,
    }
    with open(os.path.join(DATA, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    print(f"done: {len(roadmaps_meta)} roadmaps, {len(courses)} courses")


if __name__ == "__main__":
    main()
