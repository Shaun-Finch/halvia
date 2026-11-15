#!/usr/bin/env python3
"""Halvia news: gather the latest science and technology stories from publishers' public RSS/Atom feeds.

Runs weekly on GitHub Actions (.github/workflows/news.yml) and writes data/news.json, which the home page
carousel and news/index.html read. Only headlines, dates and short summaries are kept, and every story links
to the original article. If every feed fails, the existing file is left as it is so the site never empties.

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
    # (source, url, topic)
    ('ScienceDaily', 'https://www.sciencedaily.com/rss/top/science.xml', 'Science'),
    ('Phys.org', 'https://phys.org/rss-feed/', 'Science'),
    ('Nature', 'https://www.nature.com/nature.rss', 'Science'),
    ('New Scientist', 'https://www.newscientist.com/feed/home/', 'Science'),
    ('Science News', 'https://www.sciencenews.org/feed', 'Science'),
    ('ScienceDaily', 'https://www.sciencedaily.com/rss/top/technology.xml', 'Technology'),
    ('MIT Technology Review', 'https://www.technologyreview.com/feed/', 'Technology'),
    ('Tech Xplore', 'https://techxplore.com/rss-feed/', 'Technology'),
    ('ScienceDaily', 'https://www.sciencedaily.com/rss/top/health.xml', 'Health and medicine'),
    ('Medical Xpress', 'https://medicalxpress.com/rss-feed/', 'Health and medicine'),
    ('NIH', 'https://www.nih.gov/news-releases/feed.xml', 'Health and medicine'),
]
KEEP_DAYS = 21          # stories older than this are dropped
TOP_DAYS = 7            # the five top stories come from the last week
PER_FEED = 12
MAX_ITEMS = 90
SUMMARY_LEN = 240


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
        if not title or not link or not date:
            continue
        if summ.lower().startswith(title.lower()):
            summ = summ[len(title):].lstrip(' .:-')
        out.append({'title': title, 'url': link, 'source': source, 'topic': topic, 'date': date, 'summary': shorten(summ)})
    out.sort(key=lambda x: x['date'], reverse=True)
    return out[:PER_FEED]


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
        print('feed failed:', f, file=sys.stderr)
    if not items:
        print('no stories gathered; leaving the existing file as it is', file=sys.stderr)
        return 0
    items.sort(key=lambda x: x['date'], reverse=True)
    items = items[:MAX_ITEMS]
    # five top stories: the newest from the last week, one per publisher, mixing topics
    recent = [i for i in items if (now - i['date']).days <= TOP_DAYS] or items
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
