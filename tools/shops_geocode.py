"""Fill lat/lon for shopping places in src/shops.json from their Japanese address.

Uses the Geospatial Information Authority of Japan (国土地理院) address search — open government data,
no key; block-level accuracy (tens of metres), plenty for a department store or a mall.
Never uses Google. Places in the same building share the building's address and so the same point.

Usage: python3 -I tools/shops_geocode.py
"""
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'src/shops.json'
UA = 'osaka-food-map/1.0 (https://github.com/vawkdh-job/osaka-food-map)'


def gsi(addr):
    # building names after the street number confuse the search: keep up to the last number
    import re
    m = re.match(r'^(.*?\d+(?:[-－‐]\d+)*)', addr.replace('丁目', '-').replace('番地', '-').replace('番', '-').replace('号', ''))
    q = m.group(1) if m else addr
    url = 'https://msearch.gsi.go.jp/address-search/AddressSearch?' + urllib.parse.urlencode({'q': q})
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=30) as r:
        res = json.load(r)
    if not res:
        return None, q
    lon, lat = res[0]['geometry']['coordinates']
    return (round(lat, 6), round(lon, 6), res[0]['properties']['title']), q


d = json.loads(SRC.read_text(encoding='utf-8'))
cache, done = {}, 0
for s in d['shops']:
    if s.get('lat') is not None:
        continue
    a = s['address']
    if a not in cache:
        cache[a], q = gsi(a)
        time.sleep(0.4)
    hit = cache[a]
    if not hit:
        print('NO HIT', s['id'], a)
        continue
    s['lat'], s['lon'] = hit[0], hit[1]
    s['coordSrc'] = 'gsi'
    done += 1
    print(f"{s['id']:24} {hit[0]:.6f},{hit[1]:.6f}  {hit[2]}")
SRC.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding='utf-8')
print('geocoded', done)
