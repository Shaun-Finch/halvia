#!/usr/bin/env python3
"""Halvia news: gather the latest healthcare stories (hospitals and care, medicines, longevity, biology, cosmetics and skin)
from publishers' public RSS/Atom feeds.

Runs weekly on GitHub Actions (.github/workflows/news.yml) and writes data/news.json, which the home page
carousel and news/index.html read. Only headlines, dates, short summaries and the publisher's own preview image
address are kept (images are shown from the publisher's site, credited, never copied), and every story links to
the original article. If every feed fails, the existing file is left as it is so the site never empties.

Usage: python tools/news.py
"""
import datetime as dt
import email.utils
import gzip
import hashlib
import html
import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET

OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'news.json')
UA = 'Mozilla/5.0 (compatible; HalviaNews/1.0; +https://halvia.cloud/news/)'
FEEDS = [
    # (source, url, default topic). Every story is re-sorted into a topic by its words; the default is the fallback.
    ('ScienceDaily', 'https://www.sciencedaily.com/rss/top/health.xml', 'Hospitals and care'),
    ('ScienceDaily', 'https://www.sciencedaily.com/rss/health_medicine/pharmacology.xml', 'Medicines'),
    ('ScienceDaily', 'https://www.sciencedaily.com/rss/health_medicine/healthy_aging.xml', 'Longevity'),
    ('ScienceDaily', 'https://www.sciencedaily.com/rss/health_medicine/skin_care.xml', 'Cosmetics and skin'),
    ('ScienceDaily', 'https://www.sciencedaily.com/rss/plants_animals/biology.xml', 'Biology'),
    ('Medical Xpress', 'https://medicalxpress.com/rss-feed/', 'Hospitals and care'),
    ('Phys.org', 'https://phys.org/rss-feed/biology-news/', 'Biology'),
    ('NIH', 'https://www.nih.gov/news-releases/feed.xml', 'Medicines'),
    ('NHS England', 'https://www.england.nhs.uk/feed/', 'Hospitals and care'),
    ('STAT', 'https://www.statnews.com/feed/', 'Medicines'),
    ('Fierce Healthcare', 'https://www.fiercehealthcare.com/rss/xml', 'Hospitals and care'),
    ('Nature Medicine', 'https://www.nature.com/nm.rss', 'Medicines'),
    ('Nature Aging', 'https://www.nature.com/nataging.rss', 'Longevity'),
    ('New Scientist', 'https://www.newscientist.com/subject/health/feed/', 'Hospitals and care'),
    ('MIT Technology Review', 'https://www.technologyreview.com/topic/biotechnology/feed', 'Biology'),
    # cosmetics, aesthetics and skin
    ('Medical Xpress', 'https://medicalxpress.com/rss-feed/dermatology-news/', 'Cosmetics and skin'),
    ('Dermatology Times', 'https://www.dermatologytimes.com/rss', 'Cosmetics and skin'),
    ('Cosmetics Business', 'https://www.cosmeticsbusiness.com/rss', 'Cosmetics and skin'),
    ('Premium Beauty News', 'https://www.premiumbeautynews.com/spip.php?page=backend', 'Cosmetics and skin'),
    ('Healio Dermatology', 'https://www.healio.com/sws/feed/news/dermatology', 'Cosmetics and skin'),
]
# topic words, checked in this order; the first match sets the story's topic
TOPICS = [
    ('Cosmetics and skin', r'\b(skin ?care|skin (ageing|aging|cancer|condition|disease|health|barrier|cells?)|dermat\w*|cosmetic\w*|botox|botulinum|wrinkles?|acne|eczema|psoriasis|rosacea|sunscreens?|spf|dermal fillers?|aesthetic (medicine|treatments?|clinics?)|hair loss|alopecia|melanoma|collagen|scars?|beauty|anti-ageing|anti-aging|retinoids?|hyaluronic)\b'),
    ('Longevity', r'\b(ageing|aging|longevity|lifespan|healthspan|older adults|elderly|senescen\w*|dementia|alzheimer\w*|menopause|frailty|centenarians?|biological age)\b'),
    ('Medicines', r'\b(drugs?|medications?|medicines?|vaccines?|antibiotics?|doses?|dosing|clinical trials?|fda|mhra|nice|pharma\w*|prescri\w*|glp-1|ozempic|wegovy|semaglutide|tirzepatide|chemotherapy|immunotherapy|gene therapy|treatments?)\b'),
    ('Hospitals and care', r'\b(hospitals?|nhs|patients?|clinics?|nurses?|nursing|doctors?|gps?|surgeons?|surgery|emergency|icu|intensive care|care homes?|waiting lists?|ambulance|primary care|health systems?|staff|workforce|diagnos\w*|screening)\b'),
    ('Biology', r'\b(cells?|genes?|genetic\w*|genom\w*|dna|rna|proteins?|microbiome|bacteria\w*|virus\w*|immune|enzymes?|stem cells?|neurons?|brain|organisms?|evolution\w*|species|tissues?|metaboli\w*)\b'),
]
TOPICS = [(t, re.compile(rx, re.I)) for t, rx in TOPICS]
# physics, space, energy and gadget stories are left out unless the headline is clearly about health
NOT_HEALTH = re.compile(r'\b(black holes?|galax\w*|quantum|dark (energy|matter)|exoplanets?|planets?|telescopes?|astronom\w*|particle physics|physicists?|lasers?|semiconductors?|chips?|batter(y|ies)|solar storms?|earthquakes?|volcan\w*|cosmolog\w*|rockets?|satellites?|asteroids?|electric vehicles?|crypto\w*)\b', re.I)
HEALTH_WORDS = re.compile('|'.join(rx.pattern for _, rx in TOPICS), re.I)
# biology stories must connect to human health (cells, genes, disease...), not fossils, farming or wildlife
BIOMED = re.compile(r'\b(cells?|genes?|genetic\w*|genom\w*|dna|rna|proteins?|microbiome|gut|bacteria\w*|virus\w*|viral|immun\w*|infection\w*|disease\w*|cancer\w*|tumou?rs?|brain|neuro\w*|enzymes?|stem cells?|antibiotic\w*|human|patients?|health|medic\w*|blood|organs?|tissues?|metaboli\w*|hormones?|insulin|obesity|diabet\w*|heart|liver|kidney)\b', re.I)


# beauty-industry trade feeds: always filed under cosmetics and skin, never in the top five
TRADE = {'Cosmetics Business', 'Premium Beauty News'}
PER_TOPIC = 22
# some feeds mix in other languages; keep English only
NOT_ENGLISH = re.compile(r"\b(le|la|les|des|du|une|et|en|à|au|aux|pour|avec|sur|dans|son|ses|cette|qui|est|sont|nouvelle|édition|réuni|comment|fait|und|der|die|das|el|los|para|con)\b|\b[ldj]'\w", re.I)


def english(text):
    return len(NOT_ENGLISH.findall(text)) < 2 and sum(ch in 'éèêàçùôâî' for ch in text) < 3


def topic_for(title, summ, default):
    """The topic whose words appear most (headline words count three times); the feed's topic breaks ties."""
    best, score = default, 0
    for t, rx in TOPICS:
        sc = 3 * len(rx.findall(title)) + len(rx.findall(summ[:300]))
        if sc > score or (sc == score and sc and t == default):
            best, score = t, sc
    return best
KEEP_DAYS = 21          # stories older than this are dropped
TOP_DAYS = 7            # the five top stories come from the last week
PER_FEED = 12
MAX_ITEMS = 90
SUMMARY_LEN = 240
# newsletters, podcasts and round-ups are left out: the feed is for individual stories
# top stories are science and technology, not politics or general news-wire items
OFFTOPIC = re.compile(r'\b(trump|biden|administration|election|congress|senate|parliament|tariffs?|lawsuit|court|ceo|stocks?|shares|layoffs?|police|war)\b', re.I)
# top stories should report research or a development, not service news, opinion or features about the publisher
RESEARCH = re.compile(r'\b(stud(y|ies)|research(ers)?|scientists?|doctors?|clinicians?|discover(y|ed|ies)?|reveals?|finds?|found|develop(ed|s)?|trials?|experiments?|approv\w*|launch\w*|new|cells?|genes?|genetic|proteins?|vaccines?|brain|therapy|drugs?|tumou?r|cancer|patients?|hospitals?|nhs|ageing|aging|skin)\b', re.I)
NOT_NEWS = re.compile(r'\b(outage|restored|readers|letters|opinion|review:|gift|deals?|sale|subscribe|magazine|how to|best .* of 20\d\d)\b', re.I)
SKIP = re.compile(r'^(the download|the checkup|the week|this week|week in review|podcast|newsletter|quiz)\b|\b(newsletter|podcast|live updates?|crossword)\b', re.I)


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5', 'Accept-Encoding': 'gzip'})
    with urllib.request.urlopen(req, timeout=25) as r:
        data = r.read()
        if r.headers.get('Content-Encoding') == 'gzip' or data[:2] == b'\x1f\x8b':
            data = gzip.decompress(data)
    return data


def local(tag):
    return tag.rsplit('}', 1)[-1].lower()


def child(el, *names):
    for c in el:
        if local(c.tag) in names:
            return c
    return None


def text_of(el):
    return ''.join(el.itertext()).strip() if el is not None else ''


def clean(s):
    s = re.sub(r'(?is)<(script|style).*?</\1>', ' ', s or '')
    s = re.sub(r'(?s)<[^>]+>', ' ', s)
    s = html.unescape(html.unescape(s))
    s = re.sub(r'\s+', ' ', s).strip()
    s = re.sub(r'\s*(Read more|Continue reading|The post .* appeared first on .*)\.?\s*$', '', s, flags=re.I)
    return s


def shorten(s, n=SUMMARY_LEN):
    if len(s) <= n:
        return s
    cut = s[:n].rsplit(' ', 1)[0].rstrip(',;:-')
    return cut + '…'


def parse_date(s):
    s = (s or '').strip()
    if not s:
        return None
    try:
        d = email.utils.parsedate_to_datetime(s)
    except (TypeError, ValueError):
        d = None
    if d is None:
        try:
            d = dt.datetime.fromisoformat(s.replace('Z', '+00:00'))
        except ValueError:
            m = re.match(r'(\d{4}-\d{2}-\d{2})', s)
            d = dt.datetime.fromisoformat(m.group(1)) if m else None
    if d is None:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d.astimezone(dt.timezone.utc)


def safe_url(u):
    u = (u or '').strip()
    return u if re.match(r'^https?://', u, re.I) else ''


def items_from(xml_bytes, source, topic):
    root = ET.fromstring(xml_bytes)
    out = []
    for el in root.iter():
        name = local(el.tag)
        if name not in ('item', 'entry'):
            continue
        title = clean(text_of(child(el, 'title')))
        link = ''
        if name == 'entry':
            for c in el:
                if local(c.tag) == 'link' and c.get('rel', 'alternate') == 'alternate' and c.get('href'):
                    link = c.get('href'); break
        else:
            link = text_of(child(el, 'link')) or (child(el, 'guid').text if child(el, 'guid') is not None else '')
        date = parse_date(text_of(child(el, 'pubdate', 'published', 'updated', 'date', 'issued')))
        summ = clean(text_of(child(el, 'description', 'summary', 'encoded', 'content')))
        link = safe_url(link)
        if not title or not link or not date or SKIP.search(title):
            continue
        if NOT_HEALTH.search(title + ' ' + summ[:300]) and not HEALTH_WORDS.search(title):
            continue
        if re.match(r'^STAT\+\s*:', title) or not english(title):   # subscriber-only or not in English
            continue
        topic_here = topic if source in TRADE else topic_for(title, summ, topic)
        if topic_here == 'Biology' and not BIOMED.search(title + ' ' + summ[:300]):
            continue
        if summ.lower().startswith(title.lower()):
            summ = summ[len(title):].lstrip(' .:-')
        out.append({'title': title, 'url': link, 'source': source, 'topic': topic_here, 'date': date, 'summary': shorten(summ), 'image': feed_image(el)})
    out.sort(key=lambda x: x['date'], reverse=True)
    return out[:PER_FEED]


def feed_image(el):
    """The best image address the feed gives for an item: media:content / media:thumbnail / enclosure, else an <img> in the text."""
    best, bw = '', -1
    for c in el.iter():
        name = local(c.tag)
        url, w = '', 0
        if name in ('content', 'thumbnail') and c.get('url'):
            if c.get('medium', 'image') != 'image' and not (c.get('type') or 'image').startswith('image'):
                continue
            url, w = c.get('url'), int(c.get('width') or (1 if name == 'thumbnail' else 2))
        elif name == 'enclosure' and (c.get('type') or '').startswith('image') and c.get('url'):
            url, w = c.get('url'), 2
        if url and w > bw:
            best, bw = url, w
    if not best:
        m = re.search(r'<img[^>]+src=["\']([^"\']+)', ''.join(text_of(child(el, n)) for n in ('description', 'encoded', 'content', 'summary')) or '')
        if not m:
            raw = ET.tostring(el, encoding='unicode')
            m = re.search(r'<img[^>]+src=["\']([^"\']+)', html.unescape(raw))
        best = m.group(1) if m else ''
    return safe_url(html.unescape(best))


def page_image(url):
    """The share image (og:image / twitter:image) from the article page: usually the publisher's full-size picture."""
    try:
        h = fetch(url)[:400000].decode('utf-8', 'ignore')
    except Exception:
        return ''
    for prop in ('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src'):
        m = re.search(r'<meta[^>]+(?:property|name)=["\']' + re.escape(prop) + r'["\'][^>]+content=["\']([^"\']+)', h, re.I) or \
            re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']' + re.escape(prop) + r'["\']', h, re.I)
        if m:
            return safe_url(html.unescape(m.group(1)))
    return ''


def small(u):
    """Feed thumbnails that are too small for the carousel (sized folders or query strings in the address)."""
    return bool(re.search(r'/(tmb|thumb|thumbnails?|small|w\d{2,3}|\d{2,3}x\d{2,3})/|[?&](w|width)=([1-5]?\d{1,2})\b|-\d{2,3}x\d{2,3}\.', u, re.I))


def key(title):
    return re.sub(r'[^a-z0-9]+', ' ', title.lower()).strip()[:80]


def main():
    now = dt.datetime.now(dt.timezone.utc)
    seen, items, ok, failed = set(), [], [], []
    for source, url, topic in FEEDS:
        try:
            got = items_from(fetch(url), source, topic)
            ok.append(source + ' (' + topic + ')')
        except Exception as e:  # one bad feed must not stop the rest
            failed.append(f'{source} {url}: {e}')
            continue
        for it in got:
            k = key(it['title'])
            if k in seen or (now - it['date']).days > KEEP_DAYS or it['date'] > now + dt.timedelta(days=1):
                continue
            seen.add(k)
            it['id'] = hashlib.sha1(it['url'].encode()).hexdigest()[:12]
            items.append(it)
    for f in failed:
        print('feed failed:', f)
    if not items:
        print('no stories gathered; leaving the existing file as it is', file=sys.stderr)
        return 0
    items.sort(key=lambda x: x['date'], reverse=True)
    per = {}
    capped = []
    for it in items:                                  # no single topic can flood the feed
        per[it['topic']] = per.get(it['topic'], 0) + 1
        if per[it['topic']] <= PER_TOPIC:
            capped.append(it)
    items = capped[:MAX_ITEMS]
    # five top stories: the newest from the last week, one per publisher, mixing topics
    def fit(i):
        t = i['title'] + ' ' + i['summary'][:160]
        return i['source'] not in TRADE and len(i['summary']) > 60 and not OFFTOPIC.search(t) and not NOT_NEWS.search(t) and RESEARCH.search(t)
    recent = [i for i in items if (now - i['date']).days <= TOP_DAYS and fit(i)] or [i for i in items if (now - i['date']).days <= TOP_DAYS] or items
    # every top story needs a good picture: use the article's own share image when the feed's is missing or small
    checked = 0
    for it in recent:
        if checked >= 24:
            break
        if not it['image'] or small(it['image']):
            checked += 1
            it['image'] = page_image(it['url']) or ('' if small(it['image']) else it['image'])
    recent = [i for i in recent if i['image']] or recent
    top, used_src, used_topic = [], set(), {}
    for rnd in range(3):
        for it in recent:
            if len(top) == 5:
                break
            if it['id'] in [t['id'] for t in top] or it['source'] in used_src:
                continue
            if rnd == 0 and used_topic.get(it['topic'], 0) >= 2:
                continue
            top.append(it); used_src.add(it['source']); used_topic[it['topic']] = used_topic.get(it['topic'], 0) + 1
        if rnd == 1:
            used_src = set()
    for it in items:
        it['date'] = it['date'].strftime('%Y-%m-%dT%H:%M:%SZ')
    data = {'updated': now.strftime('%Y-%m-%dT%H:%M:%SZ'), 'sources': ok, 'top': [t['id'] for t in top], 'items': items}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
    print(f'{len(items)} stories from {len(ok)} feeds ({len(failed)} failed); top: ' + ' | '.join(t['title'][:50] for t in top))
    return 0


if __name__ == '__main__':
    sys.exit(main())
