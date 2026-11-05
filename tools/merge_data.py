"""Merge the current restaurant list (src/data.json) with research files into the v2 data model.

Usage: python3 -I tools/merge_data.py <research_dir> [--out src/data.json]
Research files: <research_dir>/*.json (arrays in the BRIEF.md schema). Existing entries keep their ids and verified
fields; new shops get new ids. Shops are matched by Tabelog URL (store id) or by normalised Japanese name.
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
research_dir = Path(sys.argv[1])
out = ROOT / (sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else 'src/data.json')
base = json.loads((ROOT / 'src/data.json').read_text(encoding='utf-8'))

EMOJI = {"라멘": "🍜", "츠케멘": "🍜", "우동": "🍲", "소바": "🥢", "오코노미야키": "🥞", "타코야키": "🐙", "쿠시카츠": "🍢",
         "야키니쿠": "🥩", "야키토리": "🍗", "이자카야": "🍶", "스시": "🍣", "해산물·덮밥": "🐟", "돈카츠": "🐖", "카레": "🍛",
         "양식·오므라이스": "🍳", "교자·중식": "🥟", "카페·디저트": "☕", "빵": "🥐", "킷사텐": "☕", "기타": "🍽", "오뎅": "🍢"}
GENRE_FIX = {"양식": "양식·오므라이스", "카페": "카페·디저트", "디저트": "카페·디저트", "스위츠": "카페·디저트", "츠케멘·라멘": "츠케멘"}
# rough price per genre, used only when research has nothing (marked as estimated in the app)
PRICE_GUESS = {"라멘": 1, "츠케멘": 1, "우동": 1, "소바": 1, "타코야키": 1, "카페·디저트": 1, "빵": 1, "킷사텐": 1, "카레": 1,
               "오코노미야키": 2, "쿠시카츠": 2, "돈카츠": 2, "양식·오므라이스": 2, "교자·중식": 2, "해산물·덮밥": 2, "오뎅": 2,
               "야키토리": 2, "이자카야": 3, "스시": 3, "야키니쿠": 3}
REGION_BY_AREA = [("신세카이|덴노지|天王寺|新世界", "tennoji"), ("오사카항|海遊館|天保山|大阪港", "bay"),
                  ("난바|도톤보리|신사이바시|아메무라|닛폰바시|구로몬|센니치마에|호리에|미나미센바|나가호리", "south")]


def norm(s):
    s = unicodedata.normalize('NFKC', s or '').lower()
    return re.sub(r'[\s・･\-‐ー–—()（）「」『』【】\[\]〈〉<>!！?？.,、。&＆]', '', s)


def store_id(url):
    m = re.search(r'/(\d{8})/?', url or '')
    return m.group(1) if m else None


TIME = r'(\d{1,2})[:：](\d{2})'
def parse_hours(v):
    if v is None:
        return None
    if isinstance(v, list):
        return v
    s = unicodedata.normalize('NFKC', str(v))
    if re.search(r'closed|휴무|定休|休み|休業', s, re.I) and not re.search(TIME, s):
        return []
    if re.search(r'24\s*時間|24h', s, re.I):
        return [["00:00", "24:00"]]
    out = []
    for a, b, c, d in re.findall(TIME + r'\s*[-~〜～–—]\s*(?:翌)?' + TIME, s):
        start, end = int(a) * 60 + int(b), int(c) * 60 + int(d)
        if end <= start:
            end += 24 * 60          # past midnight
        out.append([f"{int(a):02d}:{b}", f"{end // 60:02d}:{end % 60:02d}"])
    # a break written in brackets (e.g. 15:00-15:30 休憩) parses as a range inside another one: drop it
    out = [x for x in out if not any(y is not x and y[0] <= x[0] and x[1] <= y[1] for y in out)]
    return out or None


def region_of(area, lat):
    for pat, reg in REGION_BY_AREA:
        if re.search(pat, area or ''):
            return reg
    if lat is not None and lat < 34.68:
        return 'south'
    return 'north'


SEAT_TO_GROUP = {"ok": "likely", "reserve": "possible", "check": "unknown", "hard": "hard", "takeout": "unknown"}
SEAT_TO_WAIT = {"ok": "short", "reserve": "medium", "check": "unknown", "hard": "long", "takeout": "short"}

restaurants = []
by_key = {}
for r in base['restaurants']:
    if 'genre' in r and 'hyakumeiten' in r:      # already v2
        rr = dict(r)
    else:
        genre = GENRE_FIX.get(r['kind'], r['kind'])
        rr = {
            "id": r['id'], "name": r['name'], "jp": r['jp'], "genre": genre, "emoji": r['emoji'],
            "genreJp": [], "area": r['area'], "region": r['region'], "address": r['address'],
            "lat": r['lat'], "lon": r['lon'], "coordSrc": "research", "coordConf": r.get('coordConf'),
            "placeId": None, "tabelog": r['tabelog'], "tabelogReviews": None, "tabelogUrl": r['tabelogUrl'],
            "google": r['google'], "hyakumeiten": [], "budgetLunch": None, "budgetDinner": None,
            "price": PRICE_GUESS.get(genre), "priceEst": True,
            "pay": {"card": None, "emoney": None, "qr": None, "cashOnly": None},
            "seats": None, "seatTypes": [], "group6": SEAT_TO_GROUP.get(r['seatTag'], 'unknown'),
            "seatNote": r['seat'], "seatLabel": r['seatLabel'], "seatTag": r['seatTag'],
            "reservation": "possible" if r['seatTag'] == 'reserve' else "unknown",
            "onlineQueue": None, "wait": {"level": SEAT_TO_WAIT.get(r['seatTag'], 'unknown'), "note": None, "est": True},
            "ticket": None, "smoking": "unknown", "kids": None, "foreignMenu": None, "mustTry": None,
            "hours": r['hours'], "closed": r['closed'], "warn": r.get('warn'), "desc": r['desc'],
            "image": r.get('image'), "credit": r.get('credit'), "fav": r.get('fav', False),
            "sources": [], "confidence": r.get('coordConf'), "src": "v3",
        }
    restaurants.append(rr)
    by_key[store_id(rr['tabelogUrl']) or norm(rr['jp'])] = rr
    by_key[norm(rr['jp'])] = rr

GROUP_LABEL = {"likely": "6인 OK", "possible": "6인 가능성 있음", "hard": "6인 어려움", "unknown": "좌석 확인"}
GROUP_TAG = {"likely": "ok", "possible": "reserve", "hard": "hard", "unknown": "check"}
next_id = max(r['id'] for r in restaurants) + 1
added = skipped = 0
for f in sorted(research_dir.glob('*.json')):
    try:
        items = json.loads(f.read_text(encoding='utf-8'))
    except Exception as e:  # noqa: BLE001 - report and keep going
        print(f'!! {f.name}: {e}')
        continue
    for it in items:
        if not it.get('jp'):
            skipped += 1
            continue
        key = store_id(it.get('tabelog_url')) or norm(it['jp'])
        if key in by_key or norm(it['jp']) in by_key:
            skipped += 1
            continue
        genre = GENRE_FIX.get(it.get('genre'), it.get('genre')) or '기타'
        if genre not in EMOJI:
            genre = '기타'
        pay = it.get('payment') or {}
        g6 = it.get('group6') or 'unknown'
        price = it.get('price_level')
        wait = it.get('wait') or {}
        rr = {
            "id": next_id, "name": it.get('ko') or it['jp'], "jp": it['jp'], "genre": genre, "emoji": EMOJI[genre],
            "genreJp": it.get('genre_jp') or [], "area": it.get('area') or '', "region": region_of(it.get('area'), it.get('lat')),
            "address": it.get('address') or '', "lat": it.get('lat'), "lon": it.get('lon'), "coordSrc": "research" if it.get('lat') else None,
            "coordConf": it.get('confidence'), "placeId": None,
            "tabelog": it.get('tabelog_score'), "tabelogReviews": it.get('tabelog_reviews'), "tabelogUrl": it.get('tabelog_url'),
            "google": None, "hyakumeiten": it.get('hyakumeiten') or [],
            "budgetLunch": it.get('budget_lunch'), "budgetDinner": it.get('budget_dinner'),
            "price": price if price in (1, 2, 3, 4) else PRICE_GUESS.get(genre), "priceEst": price not in (1, 2, 3, 4),
            "pay": {"card": pay.get('card'), "emoney": pay.get('emoney'), "qr": pay.get('qr'), "cashOnly": pay.get('cash_only')},
            "seats": it.get('seats'), "seatTypes": it.get('seat_types') or [], "group6": g6,
            "seatNote": None, "seatLabel": GROUP_LABEL.get(g6, '좌석 확인'), "seatTag": GROUP_TAG.get(g6, 'check'),
            "reservation": it.get('reservation') or 'unknown', "onlineQueue": it.get('online_queue'),
            "wait": {"level": wait.get('level') or 'unknown', "note": wait.get('note'), "est": False},
            "ticket": it.get('ticket_machine'), "smoking": it.get('smoking') or 'unknown', "kids": it.get('kids'),
            "foreignMenu": it.get('foreign_menu'), "mustTry": it.get('must_try'),
            "hours": {d: parse_hours((it.get('hours') or {}).get(d)) for d in ('fri', 'sat', 'sun')},
            "closed": it.get('closed'), "warn": None, "desc": it.get('note') or '',
            "image": None, "credit": None, "fav": False,
            "sources": it.get('sources') or [], "confidence": it.get('confidence'), "src": f.stem,
        }
        restaurants.append(rr)
        by_key[key] = by_key[norm(rr['jp'])] = rr
        next_id += 1
        added += 1

base['restaurants'] = restaurants
base['schema'] = 2
out.write_text(json.dumps(base, ensure_ascii=False, indent=1), encoding='utf-8')
print(f'{len(restaurants)} restaurants ({added} added, {skipped} skipped as duplicates/incomplete) → {out}')
