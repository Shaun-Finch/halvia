"""Look up official logos on Wikimedia Commons with their licence details (side branch, not deployed)."""
import json, os, time, urllib.error, urllib.parse, urllib.request
API = "https://commons.wikimedia.org/w/api.php"
UA = {"User-Agent": "HalviaSiteBuilder/1.0 (https://halvia.cloud; one-off logo lookup)"}
QUERIES = []
TITLES = ["File:Grok-2025-logo.svg", "File:Grok logo without text.svg", "File:Grok-feb-2025-logo.svg"]
os.makedirs("logos", exist_ok=True)
def fetch(url):
    # Wikimedia rate-limits bursts (HTTP 429): pause between calls and back off on 429.
    for i in range(6):
        time.sleep(2 + i * 8)
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read()
        except urllib.error.HTTPError as e:
            if e.code != 429: raise
            print("429, backing off", flush=True)
    raise SystemExit("rate limited")
def get(params):
    return json.loads(fetch(API + "?" + urllib.parse.urlencode({**params, "format": "json"})))
report = []
for q in QUERIES:
    res = get({"action": "query", "generator": "search", "gsrsearch": f"filetype:drawing {q}", "gsrnamespace": 6, "gsrlimit": 6,
               "prop": "imageinfo", "iiprop": "url|size|mime|extmetadata"})
    for p in sorted(res.get("query", {}).get("pages", {}).values(), key=lambda p: p.get("index", 99)):
        ii = p["imageinfo"][0]; md = ii.get("extmetadata", {})
        row = {"query": q, "title": p["title"], "url": ii["url"], "mime": ii["mime"], "w": ii.get("width"), "h": ii.get("height"),
               "license": md.get("LicenseShortName", {}).get("value", ""), "restrictions": md.get("Restrictions", {}).get("value", ""),
               "page": "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(p["title"].replace(" ", "_"))}
        report.append(row)
        if ii["mime"] == "image/svg+xml" and len([r for r in report if r["query"] == q and r.get("saved")]) < 2:
            fn = "logos/" + p["title"].split(":", 1)[1].replace(" ", "_")
            open(fn, "wb").write(fetch(ii["url"]))
            row["saved"] = fn
res = get({"action": "query", "titles": "|".join(TITLES), "prop": "imageinfo", "iiprop": "url|size|mime|extmetadata"})
for p in res["query"]["pages"].values():
    ii = p["imageinfo"][0]; md = ii.get("extmetadata", {})
    fn = "logos/" + p["title"].split(":", 1)[1].replace(" ", "_")
    open(fn, "wb").write(fetch(ii["url"]))
    report.append({"query": "exact", "title": p["title"], "url": ii["url"], "mime": ii["mime"], "w": ii.get("width"), "h": ii.get("height"),
                   "license": md.get("LicenseShortName", {}).get("value", ""), "restrictions": md.get("Restrictions", {}).get("value", ""),
                   "artist": md.get("Artist", {}).get("value", ""), "saved": fn,
                   "page": "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(p["title"].replace(" ", "_"))})
old = json.load(open("logos/report.json")) if os.path.exists("logos/report.json") else []
json.dump(old + report, open("logos/report.json", "w"), indent=1)
for r in report: print(r["query"], "|", r["title"], "|", r["license"], "|", r["restrictions"], "|", r.get("saved", ""))
