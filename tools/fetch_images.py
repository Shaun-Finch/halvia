"""Fetch openly licensed science/health photos from Wikimedia Commons as candidates.
Keeps only public domain, CC0 and CC BY / CC BY-SA images (no NC/ND), at least 1600px wide,
and writes the licence and author for each one to candidates/credits.json."""
import json, os, re, time, urllib.parse, urllib.request
UA = {'User-Agent': 'HalviaImageFetch/1.0 (https://halvia.cloud; shaundavidfinch@gmail.com)'}
QUERIES = {
  'lab': ['scientist pipette laboratory', 'laboratory researcher microscope', 'cell culture laboratory hood'],
  'micro': ['fluorescence microscopy cells', 'scanning electron micrograph virus NIAID', 'bacteria colonies petri dish'],
  'ward': ['hospital ward nurse patient', 'patient vital signs monitor hospital', 'doctor stethoscope patient'],
  'medtech': ['hearing aid behind the ear', 'prosthetic hand myoelectric', 'printed circuit board electronics macro'],
  'research': ['DNA sequencing laboratory', 'medical conference presentation', 'pharmaceutical research laboratory'],
}
OK = re.compile(r'^(CC0|Public domain|PD|CC BY(-SA)? \d)', re.I)
def api(params):
    url = 'https://commons.wikimedia.org/w/api.php?' + urllib.parse.urlencode(params)
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60))
def strip(h): return re.sub(r'<[^>]+>', '', h or '').strip()
os.makedirs('candidates', exist_ok=True)
credits = {}
for group, qs in QUERIES.items():
    for q in qs:
        try:
            d = api({'action': 'query', 'format': 'json', 'generator': 'search', 'gsrsearch': q + ' filetype:bitmap',
                     'gsrnamespace': 6, 'gsrlimit': 25, 'prop': 'imageinfo', 'iiprop': 'url|size|extmetadata', 'iiurlwidth': 1800})
        except Exception as e:
            print('query failed', q, e); continue
        pages = sorted((d.get('query') or {}).get('pages', {}).values(), key=lambda p: p.get('index', 99))
        kept = 0
        for p in pages:
            if kept >= 5: break
            ii = (p.get('imageinfo') or [{}])[0]; md = ii.get('extmetadata', {})
            lic = strip(md.get('LicenseShortName', {}).get('value'))
            if not OK.match(lic) or re.search(r'\b(NC|ND)\b', lic) or ii.get('width', 0) < 1600: continue
            if not ii.get('thumburl') or not re.search(r'\.(jpe?g|png)$', p['title'], re.I): continue
            name = f"{group}-{re.sub(r'[^a-z0-9]+', '-', q.lower())[:30]}-{kept}.jpg"
            try:
                data = urllib.request.urlopen(urllib.request.Request(ii['thumburl'], headers=UA), timeout=60).read()
            except Exception as e:
                print('download failed', p['title'], e); continue
            open(os.path.join('candidates', name), 'wb').write(data)
            credits[name] = {'title': p['title'], 'author': strip(md.get('Artist', {}).get('value'))[:160],
                             'license': lic, 'license_url': md.get('LicenseUrl', {}).get('value', ''),
                             'source': ii.get('descriptionurl'), 'query': q}
            kept += 1; time.sleep(0.5)
        print(q, 'kept', kept)
json.dump(credits, open('candidates/credits.json', 'w'), indent=1)
print('total', len(credits))
