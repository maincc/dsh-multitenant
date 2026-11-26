#!/usr/bin/env python3
"""Read-only CSS inventory + rule parser for dsh-multitenant frontend.
Emits /tmp/cssreview/rules.json (all rules) and /tmp/cssreview/blocks.json (style blocks)."""
import json, os, re, bisect, sys

ROOT = "/Users/cly/.dshWorkspace/dsh-multitenant/frontend/src"
OUT_RULES = "/tmp/cssreview/rules.json"
OUT_BLOCKS = "/tmp/cssreview/blocks.json"

def find_css_files():
    files = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in ("node_modules", "dist")]
        for fn in filenames:
            if fn.endswith(".vue") or fn.endswith(".css"):
                files.append(os.path.join(dirpath, fn))
    return sorted(files)

def line_offsets(text):
    offs = [0]
    for m in re.finditer(r"\n", text):
        offs.append(m.end())
    return offs

def line_of(offs, idx):
    return bisect.bisect_right(offs, idx)  # 1-based line

STYLE_RE = re.compile(r"<style([^>]*)>", re.I)

def extract_style_blocks(path, text):
    """Return list of dicts: {attrs, scoped, css_start_idx, css_end_idx, tag_line}"""
    blocks = []
    for m in STYLE_RE.finditer(text):
        attrs = m.group(1)
        scoped = "scoped" in attrs
        module = "module" in attrs
        end = text.find("</style>", m.end())
        if end == -1:
            continue
        blocks.append({
            "attrs": attrs.strip(), "scoped": scoped, "module": module,
            "css_start": m.end(), "css_end": end, "tag_line": line_offsets(text)[:0] or None,
        })
    # fix tag_line properly
    offs = line_offsets(text)
    for b, m in zip(blocks, STYLE_RE.finditer(text)):
        b["tag_line"] = line_of(offs, m.start())
    return blocks

def mask_comments(text):
    """Replace comment contents with spaces (preserve length/newlines)."""
    out = list(text)
    i, n = 0, len(text)
    while i < n - 1:
        if text[i] == "/" and text[i+1] == "*":
            j = text.find("*/", i+2)
            if j == -1: j = n
            for k in range(i, min(j+2, n)):
                if out[k] != "\n": out[k] = " "
            i = j + 2
        else:
            i += 1
    return "".join(out)

def split_top_level(s):
    """Split by ';' respecting strings and braces."""
    parts, depth, in_str, esc, cur = [], 0, None, False, []
    for ch in s:
        if in_str:
            cur.append(ch)
            if esc: esc = False
            elif ch == "\\": esc = True
            elif ch == in_str: in_str = None
            continue
        if ch in "\"'":
            in_str = ch; cur.append(ch); continue
        if ch == "{": depth += 1
        elif ch == "}": depth -= 1
        if ch == ";" and depth == 0:
            parts.append("".join(cur)); cur = []
        else:
            cur.append(ch)
    if "".join(cur).strip(): parts.append("".join(cur))
    return parts

def parse_body(body_text, body_start_idx, text, offs):
    """Return declarations [{prop,value,line}] and line count of body."""
    decls = []
    depth, in_str, esc, cur, cur_start = 0, None, False, [], None
    chunks = []
    def flush(s, start):
        if s.strip(): chunks.append((s, start))
    i = 0
    while i < len(body_text):
        ch = body_text[i]
        if in_str:
            cur.append(ch)
            if esc: esc = False
            elif ch == "\\": esc = True
            elif ch == in_str: in_str = None
        else:
            if ch in "\"'":
                in_str = ch; cur.append(ch)
            elif ch == "{":
                depth += 1; cur.append(ch)
            elif ch == "}":
                depth -= 1; cur.append(ch)
            elif ch == ";" and depth == 0:
                flush("".join(cur), cur_start); cur = []; cur_start = i+1
            else:
                cur.append(ch)
                if cur_start is None: cur_start = i
        i += 1
    flush("".join(cur), cur_start if cur_start is not None else 0)
    for s, start in chunks:
        line = line_of(offs, body_start_idx + (start or 0))
        # split prop:value at first top-level ':'
        d2, istr, j = 0, None, 0
        colon = -1
        while j < len(s):
            c = s[j]
            if istr:
                if c == istr: istr = None
            elif c in "\"'": istr = c
            elif c == "(": d2 += 1
            elif c == ")": d2 -= 1
            elif c == ":" and d2 == 0:
                colon = j; break
            j += 1
        if colon == -1:
            decls.append({"prop": None, "raw": norm_ws(s), "line": line})
            continue
        prop = norm_ws(s[:colon]).lower()
        val = norm_ws(s[colon+1:]).lower()
        decls.append({"prop": prop, "value": val, "line": line})
    return decls

def norm_ws(s):
    return re.sub(r"\s+", " ", s).strip()

def parse_css(text, start_idx, offs, filepath, scoped, tag_line):
    """Walk masked text; return rules list. start_idx: absolute index of css text start in file."""
    masked = mask_comments(text)
    rules = []
    stmts = []
    n = len(masked)
    i = 0
    at_stack = []  # list of at-rule prelude strings
    def read_until(pairs, from_i):
        """read prelude until one of chars in pairs or { or ; (top level, strings aware)."""
        j = from_i; depth = 0; istr = None; esc = False
        while j < n:
            ch = masked[j]
            if istr:
                if esc: esc = False
                elif ch == istr: istr = None
            else:
                if ch in "\"'": istr = ch
                elif ch == "(": depth += 1
                elif ch == ")": depth -= 1
                elif ch == "\\" : esc = True
                elif depth == 0 and (ch in pairs or ch == "{"):
                    return j, ch
            j += 1
        return j, None
    while i < n:
        ch = masked[i]
        if ch in " \n\t;":
            i += 1; continue
        if ch == "}":
            # close current at-rule scope
            if at_stack: at_stack.pop()
            i += 1; continue
        # prelude
        j, stopch = read_until(";", i)
        prelude = norm_ws(masked[i:j])
        if stopch == ";":
            # at-statement (@import etc.)
            stmts.append({"prelude": prelude, "line": line_of(offs, start_idx + i), "kind": "statement"})
            i = j + 1
            continue
        if stopch is None:
            break
        # we are at a '{'
        # find matching close brace
        k = j + 1; depth = 1; istr = None; esc = False
        while k < n and depth > 0:
            c2 = masked[k]
            if istr:
                if esc: esc = False
                elif c2 == istr: istr = None
            else:
                if c2 in "\"'": istr = c2
                elif c2 == "{": depth += 1
                elif c2 == "}": depth -= 1
            k += 1
        body_start, body_end = j + 1, k - 1
        sel_line = line_of(offs, start_idx + i)
        body_text = masked[body_start:body_end]
        if prelude.startswith("@"):
            mname = prelude.split()[0].lower()
            if mname in ("@media", "@supports", "@layer", "@container"):
                at_stack.append(prelude)
                # recurse into inner text: parse sub-block as rules with new context
                inner_offs = offs
                sub = parse_css_region(body_text, start_idx + body_start, inner_offs, filepath, scoped, tag_line, at_stack[:])
                rules.extend(sub)
                at_stack.pop()
                i = k
                continue
            elif mname == "@keyframes":
                at_stack.append(prelude)
                sub = parse_css_region(body_text, start_idx + body_start, offs, filepath, scoped, tag_line, at_stack[:])
                rules.extend(sub)
                at_stack.pop()
                i = k
                continue
            else:
                stmts.append({"prelude": prelude, "line": sel_line, "kind": "at-block-skipped"})
                i = k
                continue
        else:
            decls = parse_body(body_text, start_idx + body_start, text, offs)
            rules.append({
                "file": filepath, "scoped": scoped, "style_tag_line": tag_line,
                "media": list(at_stack), "selector": prelude, "line": sel_line,
                "end_line": line_of(offs, start_idx + k - 1),
                "declarations": decls,
            })
            i = k
    return rules, stmts

def parse_css_region(text_region, abs_start, offs, filepath, scoped, tag_line, media_stack):
    """Parse an at-rule body that contains nested rules (each inner rule gets media_stack)."""
    rules, _ = parse_css(text_region, abs_start, offs, filepath, scoped, tag_line)
    for r in rules:
        # parse_css initialized at_stack=[] internally; fix: prepend outer stack
        r["media"] = media_stack + r["media"]
    return rules

def main():
    all_rules, all_blocks, all_stmts = [], [], []
    for path in find_css_files():
        with open(path, encoding="utf-8", errors="replace") as f:
            raw = f.read()
        offs = line_offsets(raw)
        rel = os.path.relpath(path, os.path.dirname(ROOT))
        if path.endswith(".css"):
            blocks = [{"attrs": "", "scoped": False, "module": False,
                       "css_start": 0, "css_end": len(raw), "tag_line": 1}]
        else:
            blocks = extract_style_blocks(path, raw)
        for b in blocks:
            css = raw[b["css_start"]:b["css_end"]]
            sub_offs = line_offsets(css)  # local; but we want file-level lines -> pass file offs with abs start
            rules, stmts = parse_css(css, b["css_start"], offs, rel, b["scoped"], b["tag_line"])
            n_css_lines = css.count("\n") + 1
            all_blocks.append({
                "file": rel, "tag_line": b["tag_line"], "scoped": b["scoped"],
                "attrs": b["attrs"], "css_lines": n_css_lines, "n_rules": len(rules),
                "media_rules": sum(1 for r in rules if r["media"]),
            })
            all_rules.extend(rules)
            all_stmts.extend([dict(s, file=rel) for s in stmts])
    with open(OUT_RULES, "w") as f:
        json.dump(all_rules, f, ensure_ascii=False, indent=1)
    with open(OUT_BLOCKS, "w") as f:
        json.dump(all_blocks, f, ensure_ascii=False, indent=1)
    print(f"rules={len(all_rules)} blocks={len(all_blocks)} stmts={len(all_stmts)}")

if __name__ == "__main__":
    main()
