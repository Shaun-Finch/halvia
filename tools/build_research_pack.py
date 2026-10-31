"""Turn research/raw/*.json (Europe PMC, CC BY / CC0 only) into bot/library/research.json:
short citation metadata plus passages (abstract + clinically useful sections) for offline search."""
import glob, json, re, datetime

BASIC = re.compile(r"\b(mechanis\w*|molecular|cellular|fibrosis|signal(l)?ing|pathways?|mouse|mice|rats?|murine|genetic|genom\w*|epigenet\w*|macrophage\w*|cytokine\w*|in vitro|biomarker discovery|regenerat\w*|stem cell\w*|inflammation following)\b", re.I)
BASIC_J = re.compile(r"cell|tissue|pharmacology & therapeutics|molecular|biogerontology|immunology|biochem|physiology", re.I)
INST = re.compile(r"universit|hospital|institut|college|school|centre|center|nhs|foundation|clinic|faculty|department|division|trust|council|agency|organi[sz]ation|ministry", re.I)


def institution(aff):
    parts = [p.strip(" .") for p in re.split(r"[;,]", aff or "") if p.strip()]
    parts = [p for p in parts if not re.search(r'affiliat|^[0-9]', p, re.I)]
    if not parts:
        return ''
    hits = [p for p in parts if re.search(r"universit|hospital|institut|college|nhs|trust|clinic|foundation|organi[sz]ation|council|agency", p, re.I)]
    if not hits:
        return ""
    country = parts[-1] if len(parts[-1]) < 30 and not re.search(r"\d|@", parts[-1]) else ""
    out = hits[0]
    if country and country not in out and not INST.search(country):
        out += ", " + country
    return out[:90]


def split(text, max_len=1000):
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= max_len:
        return [text]
    out, cur = [], ""
    for s in re.split(r"(?<=[.!?])\s+", text):
        if len(cur) + len(s) > max_len and cur:
            out.append(cur.strip()); cur = ""
        cur += s + " "
    if cur.strip():
        out.append(cur.strip())
    return out


def abstract_passages(ab):
    # Structured abstracts: split on headings such as "BACKGROUND:" or "Conclusions".
    ab = re.sub(r"\s+", " ", ab)
    bits = re.split(r"\b(BACKGROUND|OBJECTIVES?|AIMS?|METHODS?|RESULTS?|CONCLUSIONS?|PURPOSE|FINDINGS|INTERPRETATION|DISCUSSION|SUMMARY|INTRODUCTION|Background|Objectives?|Methods|Results|Conclusions?|Purpose|Findings|Interpretation)\s*[:.]\s*", ab)
    if len(bits) < 3:
        return [{"h": "Abstract", "text": t} for t in split(ab)]
    out, lead = [], bits[0].strip()
    if len(lead) > 60:
        out += [{"h": "Abstract", "text": t} for t in split(lead)]
    for i in range(1, len(bits) - 1, 2):
        h, body = bits[i].capitalize(), bits[i + 1].strip()
        if len(body) > 40 and not h.lower().startswith("method"):
            out += [{"h": "Abstract: " + h, "text": t} for t in split(body)]
    return out


papers, dropped = [], []
for f in sorted(glob.glob("research/raw/*.json")):
    r = json.load(open(f))
    if r["license"] not in {"cc by", "cc0", "cc-by"}:
        continue
    if BASIC.search(r["title"]) or BASIC_J.search(r["journal"] or ""):
        dropped.append(r["title"][:90]); continue
    passages = abstract_passages(r["abstract"])
    for s in r["sections"][:5]:
        passages += [{"h": s["h"], "text": t} for t in split(s["text"])[:3]]
    a = (r["authors"] or "").split(", ")
    papers.append({
        "id": r["pmcid"], "title": r["title"].rstrip("."), "authors": a[0] + (" et al." if len(a) > 1 else ""),
        "journal": re.sub(r"\s*:.*$", "", r["journal"] or "").strip().title() if (r["journal"] or "").islower() else re.sub(r"\s*:.*$", "", r["journal"] or "").strip(),
        "year": r["year"], "doi": r["doi"], "pmcid": r["pmcid"], "license": r["license"],
        "institution": institution(r["affiliation"]), "topic": r["topic"], "cited": r["cited"],
        "passages": passages[:14],
    })
papers.sort(key=lambda p: (p["topic"], -p["cited"]))
pack = {"built": datetime.date.today().isoformat(), "source": "Europe PMC open-access subset, CC BY / CC0 licences only", "papers": papers}
json.dump(pack, open("bot/library/research.json", "w"), ensure_ascii=False, separators=(",", ":"))
print(len(papers), "papers kept;", len(dropped), "dropped as basic science:")
for d in dropped: print("  -", d)
