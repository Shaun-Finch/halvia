"""Look up official logos on Wikimedia Commons with their licence details (side branch, not deployed)."""
import json, os, urllib.parse, urllib.request
API = "https://commons.wikimedia.org/w/api.php"
UA = {"User-Agent": "Halvia-site-builder/1.0 (halvia.cloud)"}
QUERIES = ["ChatGPT logo", "OpenAI logo", "Grok logo", "xAI Grok logo", "Dots logo"]
os.makedirs("logos", exist_ok=True)
def get(params):
    url = API + "?" + urllib.parse.urlencode({**params, "format": "json"})
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60))
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
            open(fn, "wb").write(urllib.request.urlopen(urllib.request.Request(ii["url"], headers=UA), timeout=60).read())
            row["saved"] = fn
json.dump(report, open("logos/report.json", "w"), indent=1)
for r in report: print(r["query"], "|", r["title"], "|", r["license"], "|", r["restrictions"], "|", r.get("saved", ""))
