"""Attach Google place IDs and coordinates to the itinerary stops (src/itinerary.json).

Uses Places API (New) Text Search with an OAuth token (gcloud user login), one search per distinct query.
Only the place ID and latitude/longitude are written (coordinates may be kept up to 30 days under the
Google Maps Platform terms); Google's names/addresses are printed for review only.

Usage: GTOKEN=$(gcloud auth print-access-token) GPROJECT=<project-id> python3 -I tools/trip_places.py
"""
import json
import os
import time
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TRIP = ROOT / 'src/itinerary.json'
TOKEN, PROJECT = os.environ['GTOKEN'], os.environ['GPROJECT']
FIELDS = 'places.id,places.location,places.displayName,places.formattedAddress,places.businessStatus'


def search(q):
    body = json.dumps({"textQuery": q, "languageCode": "ja", "regionCode": "JP", "pageSize": 1,
                       "locationBias": {"circle": {"center": {"latitude": 34.64, "longitude": 135.42}, "radius": 30000}}}).encode()
    req = urllib.request.Request('https://places.googleapis.com/v1/places:searchText', data=body, method='POST', headers={
        'Authorization': f'Bearer {TOKEN}', 'X-Goog-User-Project': PROJECT, 'Content-Type': 'application/json',
        'X-Goog-FieldMask': FIELDS})
    for attempt in range(6):                        # a new quota can take a few minutes to apply: back off on 429
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                res = json.load(r).get('places', [])
            return res[0] if res else None
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 5:
                raise
            time.sleep(30)


trip = json.loads(TRIP.read_text(encoding='utf-8'))
cache = {}
for day in trip['days']:
    for s in day['stops']:
        q = s.get('q')
        if not q or s.get('placeId'):
            continue
        if q not in cache:
            try:
                cache[q] = search(q)
            except Exception as e:  # noqa: BLE001
                print('ERROR', q, str(e)[:100], flush=True)
                cache[q] = None
        p = cache[q]
        if not p:
            print('NO MATCH', s['id'], q)
            continue
        lat, lon = p['location']['latitude'], p['location']['longitude']
        moved = abs(lat - s['lat']) + abs(lon - s['lon'])
        s.update(placeId=p['id'], lat=round(lat, 6), lon=round(lon, 6))
        flag = ' <-- moved' if moved > 0.004 else ''
        print(f"{s['id']} {q} -> {p['displayName']['text']} | {p.get('formattedAddress','')[:40]} | {p.get('businessStatus')}{flag}", flush=True)
        TRIP.write_text(json.dumps(trip, ensure_ascii=False, indent=1), encoding='utf-8')   # keep progress
trip['placesMatchedOn'] = str(date.today())
TRIP.write_text(json.dumps(trip, ensure_ascii=False, indent=1), encoding='utf-8')
print('searches:', len(cache))
