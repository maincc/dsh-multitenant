#!/usr/bin/env python3
"""Duplicate detection over rules.json: exact rule dupes, near dupes, design-value frequency,
AdminPanel vs UserCenter overlap, false-duplicate (same selector, different body) list."""
import json, re, collections, itertools, sys

rules = json.load(open("/tmp/cssreview/rules.json"))

def norm_selector(sel):
    parts = split_top_commas(sel)
    parts = [re.sub(r"\s+", " ", p).strip().lower() for p in parts]
    return ", ".join(sorted(parts))

def split_top_commas(s):
    out, cur, depth, istr = [], [], 0, None
    for ch in s:
        if istr:
            cur.append(ch)
            if ch == istr: istr = None
            continue
        if ch in "\"'": istr = ch; cur.append(ch); continue
        if ch in "((": depth += 1
        elif ch == ")": depth -= 1
        elif ch == "[": depth += 1
        elif ch == "]": depth -= 1
        if ch == "," and depth == 0:
            out.append("".join(cur)); cur = []
        else: cur.append(ch)
    if cur: out.append("".join(cur))
    return out

def body_key(r):
    ds = []
    for d in r["declarations"]:
        if d.get("prop"):
            ds.append(f"{d['prop']}:{d['value']}")
        else:
            ds.append(d["raw"])
    return tuple(sorted(ds))

def media_key(r):
    return " | ".join(sorted(re.sub(r"\s+"," ",m.strip()).lower() for m in r["media"]))

def loc(r):
    return f'{r["file"]}:{r["line"]}'

def rule_lines(r):
    return r["end_line"] - r["line"] + 1

DECL_RE = re.compile(r"declarations")

# ---------- 1. exact duplicate rules across files ----------
groups = collections.defaultdict(list)
for r in rules:
    if r["media"].startswith(("@keyframes",)) if isinstance(r["media"], str) else any(m.startswith("@keyframes") for m in r["media"]):
        key_type = "keyframe-step"
    else:
        key_type = "rule"
    groups[(key_type, norm_selector(r["selector"]), body_key(r), media_key(r))].append(r)

exact_cross = []
exact_within = []
for k, rs in groups.items():
    files = {r["file"] for r in rs}
    if len(rs) < 2: continue
    if len(files) > 1:
        exact_cross.append((k, rs))
    else:
        exact_within.append((k, rs))

exact_cross.sort(key=lambda x: -len(x[1]))
exact_within.sort(key=lambda x: -len(x[1]))

# ---------- 2. same body, different selector (≥3 declarations) ----------
by_body = collections.defaultdict(list)
for r in rules:
    bk = body_key(r)
    if len(bk) >= 3 and not any(m.startswith("@keyframes") for m in r["media"]):
        by_body[bk].append(r)
same_body_diff_sel = [v for v in by_body.values()
                      if len({norm_selector(x["selector"]) for x in v}) > 1
                      and len(v) >= 2]
same_body_diff_sel.sort(key=lambda v: -len(v))

# ---------- 3. same selector across files: identical / partial / different (false dupes) ----------
by_sel = collections.defaultdict(list)
for r in rules:
    if any(m.startswith("@keyframes") for m in r["media"]): continue
    by_sel[(norm_selector(r["selector"]), media_key(r))].append(r)

same_sel_analysis = {"identical": [], "partial": [], "different": []}
for (sel, mk), rs in by_sel.items():
    files = {r["file"] for r in rs}
    if len(files) < 2: continue
    bodies = {body_key(r) for r in rs}
    entry = {"selector": sel, "media": mk, "rules": [loc(r) for r in rs], "rs": rs}
    if len(bodies) == 1:
        same_sel_analysis["identical"].append(entry)
    else:
        # jaccard across pairwise
        bj = [set(b) for b in bodies]
        jac = len(set.intersection(*bj)) / len(set.union(*bj)) if bj else 1
        if jac >= 0.5:
            same_sel_analysis["partial"].append({**entry, "jaccard": round(jac, 2)})
        else:
            same_sel_analysis["different"].append({**entry, "jaccard": round(jac, 2)})
same_sel_analysis["partial"].sort(key=lambda e: -e["jaccard"])
same_sel_analysis["different"].sort(key=lambda e: (e["jaccard"], e["selector"]))
same_sel_analysis["identical"].sort(key=lambda e: -len(e["rules"]))

# ---------- 4. design values frequency ----------
COLOR_RE = re.compile(r"#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b(?![0-9a-fA-F])|"
                      r"\brgba?\([^)]*\)|\bhsla?\([^)]*\)")
PROPS = {
  "border-radius": re.compile(r"border(-top|-bottom|-left|-right)?-radius"),
  "box-shadow": re.compile(r"^box-shadow$|^text-shadow$"),
  "transition": re.compile(r"^transition"),
  "font-size": re.compile(r"^font-size$"),
  "spacing": re.compile(r"^(padding|margin|gap)(-(top|bottom|left|right|inline|block))?"),
  "z-index": re.compile(r"^z-index$"),
}

value_hits = collections.defaultdict(lambda: collections.defaultdict(list))  # cat -> value -> [(file,line)]
def add(cat, val, r, dline):
    value_hits[cat][val.lower()].append((r["file"], dline))

for r in rules:
    for d in r["declarations"]:
        line = d["line"]
        val = (d.get("value") or d.get("raw") or "")
        prop = d.get("prop") or ""
        for m in COLOR_RE.finditer(val):
            c = m.group(0)
            c = re.sub(r"\s+", " ", c)
            add("color", c, r, line)
        if any(m.startswith(":root") for m in []) : pass
        if prop == "--" or prop.startswith("--"):
            add("token-definition", val, r, line) if COLOR_RE.search(val) else None
        for cat, rx in PROPS.items():
            if rx.search(prop):
                add(cat, re.sub(r"\s+"," ",val), r, line)

# colors in literal vs inside var definitions
top_values = {}
for cat in value_hits:
    rows = []
    for v, lst in sorted(value_hits[cat].items(), key=lambda kv: -len(kv[1])):
        files = sorted({f for f, _ in lst})
        rows.append((v, len(lst), files, lst[:400]))
    top_values[cat] = rows

# dedupe file refs into per-value file:line lists (cap display later)
value_report = {}
for cat, rows in top_values.items():
    out = []
    for v, cnt, files, lst in rows:
        refs = [f"{f.replace('src/','')}:{ln}" for f, ln in lst]
        out.append({"value": v, "count": cnt, "n_files": len(files),
                    "files": sorted(f.replace("src/","") for f in files), "refs": refs})
    value_report[cat] = out

# ---------- 5. AdminPanel vs UserCenter overlap ----------
AP = "src/views/AdminPanel.vue"; UC = "src/views/UserCenter.vue"
ap = [r for r in rules if r["file"] == AP]; uc = [r for r in rules if r["file"] == UC]
ap_sel = {norm_selector(r["selector"]): r for r in ap}
uc_sel = {norm_selector(r["selector"]): r for r in uc}
shared_sel = sorted(set(ap_sel) & set(uc_sel))
overlap = []
for s in shared_sel:
    a, u = ap_sel[s], uc_sel[s]
    ba, bu = set(body_key(a)), set(body_key(u))
    jac = len(ba & bu)/len(ba | bu) if ba|bu else 0
    overlap.append({"selector": s, "ap_line": a["line"], "uc_line": u["line"],
                    "identical": ba == bu, "jaccard": round(jac,2),
                    "ap_media": media_key(a), "uc_media": media_key(u)})
overlap.sort(key=lambda e: (-e["identical"], -e["jaccard"]))

# body-level (selector-independent) overlap between AP & UC
ap_bodies = collections.Counter(body_key(r) for r in ap if len(body_key(r))>=2)
uc_body_set = {body_key(r) for r in uc if len(body_key(r))>=2}
uc_shared_body_rules = [r for r in uc if len(body_key(r))>=2 and body_key(r) in ap_bodies]
uc_lines_shared = sum(rule_lines(r) for r in uc_shared_body_rules)

# keyframes duplicates
kf = collections.defaultdict(list)
for r in rules:
    for m in r["media"]:
        if m.startswith("@keyframes"):
            kf[m].append(r)
kf_summary = {k: {"n_files": len({r["file"] for r in v}), "files": sorted({r["file"].replace("src/","") for r in v}),
                  "total_rules": len(v)} for k, v in kf.items()}

# media breakpoints per file
bp = collections.defaultdict(collections.Counter)
for r in rules:
    for m in r["media"]:
        if m.startswith("@media"):
            bp[r["file"]][m] += 1

result = {
  "exact_cross_files": [{"key": {"type":k[0],"selector":k[1],"media":k[3],"body":list(k[2])},
                         "locs":[loc(r) for r in rs], "n":len(rs), "files":sorted({r["file"] for r in rs}),
                         "dup_lines": sum(rule_lines(r) for r in rs[1:])}
                        for k, rs in exact_cross],
  "exact_within_file": [{"selector":k[1],"media":k[3],"locs":[loc(r) for r in rs],"file":rs[0]["file"]}
                        for k, rs in exact_within][:40],
  "same_body_diff_sel": [[{"sel":r["selector"],"loc":loc(r),"media":media_key(r)} for r in v] for v in same_body_diff_sel[:40]],
  "same_sel_partial": [{"selector":e["selector"],"jaccard":e["jaccard"],"locs":e["rules"],"media":e["media"],
                        "bodies":[body_key(r) for r in e["rs"]]} for e in same_sel_analysis["partial"][:60]],
  "same_sel_different_false_dupes": [{"selector":e["selector"],"jaccard":e["jaccard"],"locs":e["rules"],"media":e["media"],
                        "bodies":[[d for d in body_key(r)] for r in e["rs"]]} for e in same_sel_analysis["different"]],
  "same_sel_identical_count": len(same_sel_analysis["identical"]),
  "same_sel_identical_top": [{"selector":e["selector"],"media":e["media"],"locs":e["rules"]}
                             for e in same_sel_analysis["identical"][:60]],
  "values": {cat: [x for x in rows if x["count"] >= 3] for cat, rows in value_report.items()},
  "ap_uc": {"ap_rules": len(ap), "uc_rules": len(uc), "shared_selectors": overlap,
            "uc_rules_sharing_ap_body": len(uc_shared_body_rules),
            "uc_style_lines": 1059, "uc_lines_sharing_ap_body": uc_lines_shared},
  "keyframes": kf_summary,
  "breakpoints_per_file": {f.replace("src/",""): dict(c) for f, c in sorted(bp.items())},
}
json.dump(result, open("/tmp/cssreview/analysis.json","w"), ensure_ascii=False, indent=1)

# quick console summary
print("== exact cross-file dup rule groups:", len(exact_cross),
      " total dup lines:", sum(sum(rule_lines(r) for r in rs[1:]) for _,rs in exact_cross))
print("== same-body-diff-sel groups:", len(same_body_diff_sel))
print("== same selector across files: identical:", len(same_sel_analysis["identical"]),
      " partial:", len(same_sel_analysis["partial"]), " different(FALSE):", len(same_sel_analysis["different"]))
print("== AP/UC shared selectors:", len(shared_sel), " identical bodies:", sum(1 for o in overlap if o["identical"]))
print("== UC rules sharing AP body:", len(uc_shared_body_rules), "lines:", uc_lines_shared)
print("== keyframes:", {k: v["n_files"] for k, v in kf_summary.items()})
print("wrote analysis.json")
