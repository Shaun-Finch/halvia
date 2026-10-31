"""Fetch open-access, openly licensed (CC BY / CC0) peer-reviewed reviews and guidelines
from Europe PMC for acute hospital topics. Writes one JSON file per paper to research/raw/.
Runs in GitHub Actions (the build sandbox can't reach Europe PMC)."""
import json, os, re, sys, time, urllib.parse, urllib.request
import xml.etree.ElementTree as ET

API = "https://www.ebi.ac.uk/europepmc/webservices/rest/"
OUT = "research/raw"
PER_TOPIC = int(os.environ.get("PER_TOPIC", "6"))
OK_LICENCES = {"cc by", "cc0", "cc-by", "cc by 4.0", "cc by 3.0", "cc by 2.0"}

TOPICS = [
    ("sepsis", '"sepsis" OR "septic shock"'),
    ("early warning scores", '"early warning score" OR "NEWS2" OR "deteriorating patient" OR "rapid response team"'),
    ("cardiac arrest", '"cardiac arrest" OR "cardiopulmonary resuscitation"'),
    ("anaphylaxis", '"anaphylaxis"'),
    ("acute coronary syndrome", '"acute coronary syndrome" OR "myocardial infarction"'),
    ("atrial fibrillation", '"atrial fibrillation"'),
    ("acute heart failure", '"acute heart failure"'),
    ("pulmonary embolism", '"pulmonary embolism"'),
    ("venous thromboembolism", '"venous thromboembolism" OR "thromboprophylaxis"'),
    ("stroke", '"acute ischaemic stroke" OR "acute ischemic stroke" OR "thrombolysis stroke" OR "mechanical thrombectomy"'),
    ("status epilepticus", '"status epilepticus"'),
    ("head injury", '"traumatic brain injury" OR "head injury"'),
    ("delirium", '"delirium"'),
    ("falls in hospital", '"inpatient falls" OR "falls prevention hospital"'),
    ("acute kidney injury", '"acute kidney injury"'),
    ("hyperkalaemia", '"hyperkalemia" OR "hyperkalaemia"'),
    ("hyponatraemia", '"hyponatremia" OR "hyponatraemia"'),
    ("diabetic ketoacidosis", '"diabetic ketoacidosis" OR "hyperosmolar hyperglycaemic" OR "hyperosmolar hyperglycemic"'),
    ("hypoglycaemia", '"hypoglycemia" OR "hypoglycaemia"'),
    ("asthma exacerbation", '"acute asthma" OR "asthma exacerbation"'),
    ("COPD exacerbation", '"COPD exacerbation" OR "exacerbation of chronic obstructive pulmonary disease"'),
    ("pneumonia", '"community-acquired pneumonia" OR "hospital-acquired pneumonia"'),
    ("oxygen therapy", '"oxygen therapy" OR "oxygen saturation target"'),
    ("upper GI bleeding", '"upper gastrointestinal bleeding" OR "variceal bleeding"'),
    ("acute pancreatitis", '"acute pancreatitis"'),
    ("alcohol withdrawal", '"alcohol withdrawal"'),
    ("paracetamol overdose", '"paracetamol overdose" OR "acetaminophen overdose" OR "acetaminophen poisoning"'),
    ("opioid overdose", '"opioid overdose" OR "naloxone"'),
    ("major haemorrhage", '"major haemorrhage" OR "massive transfusion" OR "tranexamic acid"'),
    ("blood transfusion", '"blood transfusion" OR "patient blood management"'),
    ("burns", '"burn injury" OR "burns management"'),
    ("acute pain", '"acute pain management" OR "postoperative pain"'),
    ("antimicrobial stewardship", '"antimicrobial stewardship"'),
    ("urinary tract infection", '"urinary tract infection"'),
    ("cellulitis and skin infection", '"cellulitis" OR "skin and soft tissue infection"'),
    ("meningitis", '"bacterial meningitis" OR "meningococcal"'),
    ("COVID-19 in hospital", '"COVID-19" AND ("hospitalised" OR "hospitalized" OR "management")'),
    ("frailty", '"frailty" OR "comprehensive geriatric assessment"'),
    ("pressure ulcers", '"pressure ulcer" OR "pressure injury"'),
    ("refeeding and nutrition", '"refeeding syndrome" OR "malnutrition hospital"'),
    ("intravenous fluids", '"fluid therapy" OR "intravenous fluids" OR "fluid resuscitation"'),
    ("infection prevention", '"hand hygiene" OR "infection prevention and control"'),
    ("medication safety", '"medication errors" OR "medication safety"'),
    ("handover and communication", '"clinical handover" OR "SBAR" OR "handoff"'),
    ("end of life care", '"end-of-life care" OR "palliative care hospital"'),
    ("syncope", '"syncope"'),
    ("chest pain", '"acute chest pain"'),
    ("hypertension emergency", '"hypertensive emergency"'),
    ("acute abdomen", '"acute abdominal pain" OR "acute appendicitis"'),
    ("diabetes inpatient", '"inpatient diabetes" OR "perioperative diabetes"'),
]
TYPES = '(PUB_TYPE:"review" OR PUB_TYPE:"systematic review" OR PUB_TYPE:"meta-analysis" OR PUB_TYPE:"practice guideline" OR PUB_TYPE:"guideline")'
KEEP_SEC = re.compile(r"conclu|summary|recommend|management|treatment|therap|diagnos|key (points|messages|findings)|clinical (implications|practice|features|presentation)|assessment|implications|definition|interpretation", re.I)


def get(url, kind="json", tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Halvia-bot-library-builder (halvia.cloud)"})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            return json.loads(data) if kind == "json" else data
        except Exception as e:  # noqa: BLE001
            print("retry", i, url[:120], e, file=sys.stderr)
            time.sleep(2 ** i)
    return None


def text_of(el):
    # Drop citation markers and tables/figures; keep running text.
    for bad in el.findall(".//xref") + el.findall(".//table-wrap") + el.findall(".//fig"):
        bad.clear()
    return re.sub(r"\s+", " ", "".join(el.itertext())).strip()


def sections(xml_bytes):
    out = []
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return out
    body = root.find(".//body")
    if body is None:
        return out
    for sec in body.iter("sec"):
        t = sec.find("title")
        title = text_of(t) if t is not None else ""
        if not title or not KEEP_SEC.search(title):
            continue
        paras = [text_of(p) for p in sec.findall("p")]
        txt = "\n\n".join(p for p in paras if len(p) > 40)
        if len(txt) > 200:
            out.append({"h": title[:140], "text": txt[:6000]})
    return out[:6]


def main():
    os.makedirs(OUT, exist_ok=True)
    seen = {f[:-5] for f in os.listdir(OUT)}
    total = 0
    for topic, q in TOPICS:
        query = f"(TITLE:({q})) AND OPEN_ACCESS:Y AND HAS_FT:Y AND {TYPES} AND PUB_YEAR:[2016 TO 2026]"
        url = API + "search?" + urllib.parse.urlencode({"query": query, "format": "json", "resultType": "core", "pageSize": 40, "sort": "CITED desc"})
        res = get(url) or {}
        hits = res.get("resultList", {}).get("result", [])
        kept = 0
        for h in hits:
            if kept >= PER_TOPIC:
                break
            lic = (h.get("license") or "").lower().strip()
            pmcid = h.get("pmcid")
            if lic not in OK_LICENCES or not pmcid or pmcid in seen or not h.get("abstractText"):
                continue
            authors = h.get("authorList", {}).get("author", [])
            aff = ""
            if authors:
                a0 = authors[0]
                aff = a0.get("affiliation") or ""
                det = a0.get("authorAffiliationDetailsList", {}).get("authorAffiliation", [])
                if not aff and det:
                    aff = det[0].get("affiliation", "")
            ft = get(API + f"{pmcid}/fullTextXML", kind="raw")
            secs = sections(ft) if ft else []
            rec = {
                "pmcid": pmcid, "pmid": h.get("pmid"), "doi": h.get("doi"), "topic": topic,
                "title": re.sub(r"<[^>]+>", "", h.get("title", "")).strip(),
                "authors": h.get("authorString", ""), "affiliation": aff,
                "journal": h.get("journalInfo", {}).get("journal", {}).get("title", ""),
                "year": h.get("pubYear"), "license": lic, "cited": h.get("citedByCount", 0),
                "pubtypes": h.get("pubTypeList", {}).get("pubType", []),
                "abstract": re.sub(r"<[^>]+>", " ", h.get("abstractText", "")).strip(),
                "sections": secs,
            }
            with open(f"{OUT}/{pmcid}.json", "w") as f:
                json.dump(rec, f, ensure_ascii=False, indent=1)
            seen.add(pmcid)
            kept += 1
            total += 1
            time.sleep(0.15)
        print(f"{topic}: {len(hits)} hits, kept {kept}")
    print("total new papers", total)


if __name__ == "__main__":
    main()
