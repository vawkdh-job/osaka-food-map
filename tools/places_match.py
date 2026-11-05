"""Attach Google place IDs and exact coordinates to every restaurant in src/data.json.

Uses Places API (New) Text Search with an OAuth access token (gcloud user login), billed to the project.
Only the place ID (may be stored indefinitely) and latitude/longitude (may be cached up to 30 days under the
Google Maps Platform terms) are written; names/addresses returned by Google are used for matching only.
Permanently closed places are removed.

Usage: GTOKEN=$(gcloud auth print-access-token) GPROJECT=<project-id> python3 -I tools/places_match.py
"""
import json
import math
import os
import re
import sys
import time
import unicodedata
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'src/data.json'
TOKEN, PROJECT = os.environ['GTOKEN'], os.environ['GPROJECT']
FIELDS = 'places.id,places.location,places.displayName,places.formattedAddress,places.businessStatus,places.types'
BBOX = (34.60, 34.76, 135.39, 135.57)          # Osaka city core incl. the port
AREA_JP = {"우메다": "梅田", "기타신치": "北新地", "나카자키초": "中崎町", "덴마": "天満", "덴진바시스지": "天神橋筋", "후쿠시마": "福島",
           "나카노시마": "中之島", "기타하마": "北浜", "혼마치": "本町", "신사이바시": "心斎橋", "아메무라": "アメリカ村", "난바": "難波",
           "도톤보리": "道頓堀", "닛폰바시": "日本橋", "구로몬": "黒門", "신세카이": "新世界", "덴노지": "天王寺", "오사카항": "大阪港",
           "미나미모리마치": "南森町", "나카쓰": "中津", "히고바시": "肥後橋", "요도야바시": "淀屋橋", "센니치마에": "千日前", "호리에": "堀江"}


def norm(s):
    s = unicodedata.normalize('NFKC', s or '').lower()
    return re.sub(r'[\s・･\-‐ー–—()（）「」『』【】\[\]〈〉<>!！?？.,、。&＆\'’"]', '', s)


BRANCH = re.compile(r'(本店|総本店|本舗|支店|[^\s]{1,8}店|大阪|梅田|難波|なんば|心斎橋|道頓堀|天満|福島)$')
def core(name):
    n = norm(name)
    for _ in range(3):
        m = BRANCH.search(n)
        if m and len(n) - len(m.group(0)) >= 2:
            n = n[:m.start()]
    return n


def name_match(ours, theirs):
    a, b = core(ours), norm(theirs)
    if not a or not b:
        return False
    if a in b or core(theirs) in norm(ours):
        return True
    sa, sb = set(a), set(b)
    return len(sa & sb) / max(1, min(len(sa), len(sb))) >= 0.6


def variants(name):
    """The name plus, for 'Name (Reading)', each part on its own."""
    out = [name]
    m = re.match(r'^(.*?)[\s　]*[(（](.*?)[)）]\s*$', name or '')
    if m:
        out += [m.group(1), m.group(2)]
    return [v for v in out if v.strip()]


def km(a, b):
    p = math.pi / 180
    t = math.sin((b[0] - a[0]) * p / 2) ** 2 + math.cos(a[0] * p) * math.cos(b[0] * p) * math.sin((b[1] - a[1]) * p / 2) ** 2
    return 12742 * math.asin(math.sqrt(t))


def search(q):
    body = json.dumps({"textQuery": q, "languageCode": "ja", "regionCode": "JP", "pageSize": 5,
                       "locationBias": {"circle": {"center": {"latitude": 34.683, "longitude": 135.495}, "radius": 12000}}}).encode()
    req = urllib.request.Request('https://places.googleapis.com/v1/places:searchText', data=body, method='POST', headers={
        'Authorization': f'Bearer {TOKEN}', 'X-Goog-User-Project': PROJECT, 'Content-Type': 'application/json',
        'X-Goog-FieldMask': FIELDS})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r).get('places', [])


def area_word(area):
    for k, v in AREA_JP.items():
        if k in (area or ''):
            return v
    return ''


d = json.loads(DATA.read_text(encoding='utf-8'))
keep, report = [], []
for r in d['restaurants']:
    if r.get('placeId') and r.get('coordSrc') == 'google':
        keep.append(r)
        continue
    hint = r['address'] or f"大阪 {area_word(r.get('area'))} {(r.get('genreJp') or [''])[0]}"
    best = None
    for q in [f"{r['jp']} {hint}".strip(), f"{r['jp']} 大阪"]:
        try:
            res = search(q)
        except Exception as e:  # noqa: BLE001 - log and continue
            report.append((r['id'], r['jp'], 'ERROR', str(e)[:80]))
            res = []
        for p in res:
            loc = p.get('location') or {}
            lat, lon = loc.get('latitude'), loc.get('longitude')
            if lat is None or not (BBOX[0] <= lat <= BBOX[1] and BBOX[2] <= lon <= BBOX[3]):
                continue
            if not any(name_match(v, p['displayName']['text']) for v in variants(r['jp'])):
                continue
            if r.get('lat') and km((r['lat'], r['lon']), (lat, lon)) > 0.6:
                continue                                   # same name but far from the researched spot → another branch
            num = re.findall(r'\d+(?:-\d+)+', unicodedata.normalize('NFKC', r['address'] or '').replace('丁目', '-').replace('番地', '-').replace('番', '-').replace('号', ''))
            gaddr = unicodedata.normalize('NFKC', p.get('formattedAddress', '')).replace('丁目', '-').replace('−', '-').replace('番地', '-')
            if num and num[0].rstrip('-') not in gaddr:
                continue                                   # our street number must appear in Google's address
            best = p
            break
        if best:
            break
        time.sleep(0.1)
    if not best:
        report.append((r['id'], r['jp'], 'NO MATCH', hint[:40]))
        if r.get('lat'):
            keep.append(r)                                 # keep researched coordinates
        continue
    if best.get('businessStatus') == 'CLOSED_PERMANENTLY':
        report.append((r['id'], r['jp'], 'CLOSED', best['displayName']['text']))
        continue
    lat, lon = best['location']['latitude'], best['location']['longitude']
    moved = round(km((r['lat'], r['lon']), (lat, lon)) * 1000) if r.get('lat') else None
    r.update(placeId=best['id'], lat=round(lat, 6), lon=round(lon, 6), coordSrc='google', coordDate=str(date.today()))
    if best.get('businessStatus') == 'CLOSED_TEMPORARILY':
        r['warn'] = ((r.get('warn') or '') + ' 구글에 임시 휴업으로 표시됨 — 가기 전 확인').strip()
        report.append((r['id'], r['jp'], 'TEMP CLOSED', ''))
    report.append((r['id'], r['jp'], 'OK', f"moved {moved} m" if moved is not None else 'new coords'))
    keep.append(r)

d['restaurants'] = keep
d['placesMatchedOn'] = str(date.today())
DATA.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding='utf-8')
ok = sum(1 for x in report if x[2] == 'OK')
print(f"matched {ok}, kept {len(keep)} of {len(keep) + sum(1 for x in report if x[2] in ('CLOSED',)) + sum(1 for x in report if x[2]=='NO MATCH' and True)}")
for x in report:
    if x[2] != 'OK' or (x[3].startswith('moved') and int(x[3].split()[1]) > 150):
        print(*x, sep=' | ')
