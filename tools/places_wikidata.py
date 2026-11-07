"""Build src/places.json: landmarks, areas and stations for the place search.

Coordinates and Japanese labels come from Wikidata (CC0) — never from Google.
Korean names/aliases for landmarks are curated here (Wikidata's Korean labels are
often literal readings such as 해유관 for 海遊館); station names use Wikidata's Korean label.

Usage: python3 -I tools/places_wikidata.py   (needs https access to query.wikidata.org)
"""
import json
import re
import time
import urllib.parse
import urllib.request
from math import cos, hypot, radians
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'src/places.json'
UA = 'osaka-food-map-gazetteer/1.0 (https://github.com/vawkdh-job/osaka-food-map)'
BOX = (34.58, 135.38, 34.82, 135.60)   # south, west, north, east (Osaka city + Expo park)

# key, Korean name, aliases (ko/en/ja), emoji, Wikidata Japanese label candidates (first found wins)
CURATED = [
    ('osakajo', '오사카성', ['오사카 성', '오사카조', '오사카성 천수각', '천수각', 'osaka castle', '大阪城天守閣'], '🏯', ['大阪城', '大阪城天守閣']),
    ('osakajopark', '오사카성 공원', ['오사카조 공원', '오사카성공원', 'osaka castle park'], '🌳', ['大阪城公園']),
    ('dotonbori', '도톤보리', ['도톤보리 글리코', '글리코', '글리코 간판', 'dotonbori', '道頓堀'], '🌃', ['道頓堀']),
    ('ebisubashi', '에비스바시 (글리코 간판)', ['에비스바시', '에비스 다리', 'ebisubashi', 'glico'], '🏃', ['戎橋']),
    ('shinsaibashisuji', '신사이바시스지 상점가', ['신사이바시스지', '신사이바시 상점가', 'shinsaibashi-suji'], '🛍', ['心斎橋筋商店街', '心斎橋筋']),
    ('kuromon', '구로몬 시장', ['쿠로몬 시장', '구로몬', '쿠로몬', 'kuromon market'], '🦀', ['黒門市場']),
    ('shinsekai', '신세카이', ['신세계', 'shinsekai'], '🏮', ['新世界 (大阪)', '新世界']),
    ('tsutenkaku', '츠텐카쿠', ['쓰텐카쿠', '통천각', 'tsutenkaku'], '🗼', ['通天閣']),
    ('janjan', '잔잔요코초', ['잔잔 요코초', 'janjan yokocho'], '🍢', ['ジャンジャン横丁']),
    ('harukas', '아베노 하루카스', ['하루카스', '아베노하루카스', 'abeno harukas', '하루카스 300'], '🏙', ['あべのハルカス']),
    ('tennojipark', '텐노지 공원', ['덴노지 공원', '텐시바', 'tennoji park'], '🌳', ['天王寺公園']),
    ('tennojizoo', '텐노지 동물원', ['덴노지 동물원', 'tennoji zoo'], '🦁', ['天王寺動物園']),
    ('shitennoji', '시텐노지', ['사천왕사', 'shitennoji'], '⛩', ['四天王寺']),
    ('kaiyukan', '가이유칸 (오사카 수족관)', ['가이유칸', '카이유칸', '오사카 수족관', '해유관', 'kaiyukan', 'aquarium'], '🐋', ['海遊館']),
    ('tempozan', '덴포잔 대관람차', ['텐포잔', '덴포잔', '텐포잔 관람차', 'tempozan'], '🎡', ['天保山大観覧車']),
    ('usj', '유니버설 스튜디오 재팬 (USJ)', ['유니버설', '유니버셜', 'usj', '유에스제이', 'universal studios'], '🎢', ['ユニバーサル・スタジオ・ジャパン']),
    ('skybuilding', '우메다 스카이빌딩', ['스카이빌딩', '공중정원', 'umeda sky building'], '🌇', ['梅田スカイビル']),
    ('hepfive', 'HEP FIVE (관람차)', ['헵파이브', '헵 파이브', 'hep five', '우메다 관람차'], '🎡', ['HEP FIVE', 'HEP']),
    ('grandfront', '그랜드 프런트 오사카', ['그랜드프런트', '그랜드 프론트', 'grand front osaka'], '🏬', ['グランフロント大阪']),
    ('grangreen', '그랑 그린 오사카 (우메키타 공원)', ['우메키타', '우메키타 공원', 'grand green osaka', 'umekita'], '🌳', ['グラングリーン大阪', 'うめきた公園']),
    ('stationcity', '오사카 스테이션 시티 (루쿠아)', ['루쿠아', '오사카역 루쿠아', 'lucua', 'osaka station city'], '🛍', ['大阪ステーションシティ']),
    ('hankyu', '한큐·한신 백화점 (우메다)', ['한큐 백화점', '한큐백화점', '한큐 우메다', '한신 백화점', '한신백화점', '한신 우메다', 'hankyu', 'hanshin'], '🎁', ['阪急うめだ本店', '阪急百貨店うめだ本店']),
    ('kitashinchi', '기타신치', ['키타신치', 'kitashinchi'], '🍶', ['北新地']),
    ('nakazakicho', '나카자키초', ['나카자키쵸', 'nakazakicho'], '☕', ['中崎町', '中崎町駅']),
    ('tenjinbashisuji', '텐진바시스지 상점가', ['덴진바시스지', '텐진바시스지', '텐마', 'tenjinbashisuji'], '🛍', ['天神橋筋商店街', '天満駅']),
    ('tenmangu', '오사카 텐만구', ['텐만구', '덴만구', 'osaka tenmangu'], '⛩', ['大阪天満宮']),
    ('nakanoshima', '나카노시마', ['나카노시마 공원', 'nakanoshima'], '🌳', ['中之島公園', '中之島']),
    ('kokaido', '오사카시 중앙공회당', ['중앙공회당', '공회당', 'central public hall'], '🏛', ['大阪市中央公会堂']),
    ('nakanoshimamuseum', '나카노시마 미술관', ['오사카 나카노시마 미술관', 'nakanoshima museum of art'], '🖼', ['大阪中之島美術館']),
    ('nmao', '국립국제미술관', ['국립 국제 미술관', 'national museum of art osaka'], '🖼', ['国立国際美術館']),
    ('sciencemuseum', '오사카시립과학관', ['과학관', 'osaka science museum'], '🔭', ['大阪市立科学館']),
    ('historymuseum', '오사카 역사박물관', ['역사박물관', 'osaka museum of history'], '🏛', ['大阪歴史博物館']),
    ('housingmuseum', '오사카 주택박물관 (오사카 구라시노 곤자쿠칸)', ['주택박물관', '곤자쿠칸', '기모노 체험'], '🏠', ['大阪くらしの今昔館']),
    ('mint', '조폐국 (벚꽃길)', ['오사카 조폐국', '조폐국', 'japan mint'], '🌸', ['造幣局 (日本)', '造幣局']),
    ('kitahama', '기타하마', ['키타하마', 'kitahama'], '☕', ['北浜']),
    ('cityhall', '오사카 시청', ['시청', 'osaka city hall'], '🏛', ['大阪市役所']),
    ('americamura', '아메리카무라', ['아메무라', '아메리카 마을', 'amerikamura'], '🛹', ['アメリカ村']),
    ('horie', '호리에', ['오렌지 스트리트', 'horie'], '👟', ['堀江 (大阪市)', '堀江']),
    ('hozenji', '호젠지 요코초', ['호젠지', '법선사', 'hozenji'], '🏮', ['法善寺横丁', '法善寺']),
    ('dogugai', '센니치마에 도구야스지', ['도구야스지', '도구 거리', '주방용품 거리', 'doguyasuji'], '🔪', ['千日前道具屋筋商店街', '道具屋筋', '難波駅']),
    ('dendentown', '덴덴타운 (닛폰바시)', ['덴덴타운', '오타로드', '닛폰바시 전자상가', 'den den town'], '🎮', ['でんでんタウン', '日本橋 (大阪市)']),
    ('namba_parks', '난바 파크스', ['난바파크스', 'namba parks'], '🛍', ['なんばパークス']),
    ('ngk', '난바 그랜드 가게쓰', ['요시모토', 'ngk', '난바 그랜드 카게츠'], '🎭', ['なんばグランド花月']),
    ('yasaka', '난바 야사카 신사', ['야사카 신사', '사자 신사', 'namba yasaka'], '🦁', ['難波八阪神社']),
    ('sumiyoshi', '스미요시 타이샤', ['스미요시 대사', '스미요시', 'sumiyoshi taisha'], '⛩', ['住吉大社']),
    ('koreatown', '츠루하시 시장 · 코리아타운', ['코리아타운', '오사카 코리아타운', '쓰루하시 시장', '츠루하시 시장', '이쿠노 코리아타운'], '🇰🇷', ['大阪コリアタウン', '生野コリアタウン', '鶴橋駅']),
    ('kyoceradome', '교세라 돔 오사카', ['교세라돔', '오사카 돔', 'kyocera dome'], '⚾', ['大阪ドーム']),
    ('osakajohall', '오사카성 홀', ['오사카조 홀', 'osaka-jo hall'], '🎤', ['大阪城ホール']),
    ('expopark', '만박기념공원 (태양의 탑)', ['엑스포 공원', '만박공원', '태양의 탑', 'expo park', 'expo city'], '🌞', ['万博記念公園']),
    ('spaworld', '스파월드', ['스파 월드', 'spa world'], '♨️', ['スパワールド']),
    ('isshinji', '잇신지', ['isshinji'], '⛩', ['一心寺']),
    ('tennoji', '텐노지', ['덴노지', 'tennoji'], '🚉', ['天王寺 (大阪市)', '天王寺']),
    ('cosmotower', '사키시마 코스모타워 전망대', ['코스모타워', '사키시마', 'cosmo tower'], '🌆', ['大阪府咲洲庁舎']),
]

# areas people type that are best served by a station's point
AREAS = [  # Korean name, aliases, emoji, station Japanese label
    ('우메다', ['umeda', '키타', '기타'], '🏙', '大阪メトロ梅田駅'),
    ('오사카역', ['osaka station', 'jr 오사카역'], '🚉', '大阪駅'),
    ('난바', ['namba', '남바', '미나미'], '🏙', '難波駅'),
    ('신사이바시', ['shinsaibashi', '신사이바시역'], '🛍', '心斎橋駅'),
    ('혼마치', ['hommachi', '혼마찌'], '🏢', '本町駅'),
    ('요도야바시', ['yodoyabashi'], '🏢', '淀屋橋駅'),
    ('후쿠시마', ['fukushima', '후쿠시마 맛집'], '🍶', '福島駅 (大阪府)'),
    ('텐마', ['tenma', '덴마'], '🍶', '天満駅'),
    ('교바시', ['kyobashi', '쿄바시'], '🍶', '京橋駅 (大阪府)'),
    ('츠루하시', ['tsuruhashi', '쓰루하시', '쯔루하시'], '🥩', '鶴橋駅'),
    ('신오사카', ['shin-osaka', '신오사카역'], '🚄', '新大阪駅'),
    ('닛폰바시', ['nippombashi', '니혼바시', '닛뽄바시'], '🎮', '日本橋駅 (大阪府)'),
    ('에비스초', ['ebisucho'], '🏮', '恵美須町駅'),
    ('도부쓰엔마에', ['dobutsuen-mae', '동물원앞'], '🏮', '動物園前駅'),
    ('모리노미야', ['morinomiya'], '🏯', '森ノ宮駅'),
    ('텐진바시스지 6초메', ['tenjimbashisuji 6-chome', '텐로쿠'], '🛍', '天神橋筋六丁目駅'),
]


def sparql(q):
    url = 'https://query.wikidata.org/sparql?' + urllib.parse.urlencode({'query': q})
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/sparql-results+json'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return [{k: v['value'] for k, v in b.items()} for b in json.load(r)['results']['bindings']]
        except Exception:  # noqa: BLE001
            if attempt == 3:
                raise
            time.sleep(10 * (attempt + 1))


def box_service():
    s, w, n, e = BOX
    return f'''SERVICE wikibase:box {{ ?item wdt:P625 ?loc .
      bd:serviceParam wikibase:cornerSouthWest "Point({w} {s})"^^geo:wktLiteral .
      bd:serviceParam wikibase:cornerNorthEast "Point({e} {n})"^^geo:wktLiteral . }}'''


def by_labels(labels):
    vals = ' '.join(json.dumps(l, ensure_ascii=False) + '@ja' for l in labels)
    q = f'''SELECT ?item ?ja ?ko ?en ?lat ?lon ?sl WHERE {{
      VALUES ?ja {{ {vals} }}
      ?item rdfs:label ?ja . {box_service()}
      ?item wikibase:sitelinks ?sl .
      OPTIONAL {{ ?item rdfs:label ?ko FILTER(LANG(?ko)="ko") }}
      OPTIONAL {{ ?item rdfs:label ?en FILTER(LANG(?en)="en") }}
      BIND(geof:latitude(?loc) AS ?lat) BIND(geof:longitude(?loc) AS ?lon) }}'''
    best = {}
    for r in sparql(q):
        k = r['ja']
        if k not in best or int(r['sl']) > int(best[k]['sl']):
            best[k] = r
    return best


def stations():
    q = f'''SELECT DISTINCT ?item ?ja ?ko ?en ?lat ?lon WHERE {{ {box_service()}
      ?item wdt:P31/wdt:P279* wd:Q55488 .
      FILTER NOT EXISTS {{ ?item wdt:P576 ?gone }}
      ?item rdfs:label ?ja FILTER(LANG(?ja)="ja")
      OPTIONAL {{ ?item rdfs:label ?ko FILTER(LANG(?ko)="ko") }}
      OPTIONAL {{ ?item rdfs:label ?en FILTER(LANG(?en)="en") }}
      BIND(geof:latitude(?loc) AS ?lat) BIND(geof:longitude(?loc) AS ?lon) }}'''
    return sparql(q)


def km(a, b):
    return hypot((a[0] - b[0]) * 111.0, (a[1] - b[1]) * 111.0 * cos(radians(a[0])))


def clean_ko(s):
    return re.sub(r'\s*\(.*?\)\s*', '', s or '').strip()


def main():
    out, missing = [], []
    st_rows = stations()
    time.sleep(65)   # the public endpoint may rate-limit to one query a minute
    labels = sorted({l for c in CURATED for l in c[4] if not l.endswith('駅')})
    found = by_labels(labels)
    by_station = {}   # station name without the operator suffix -> rows
    for r in st_rows:
        by_station.setdefault(re.sub(r'\s*\(.*?\)$', '', r['ja']), []).append(r)
    for name, rows in by_station.items():   # one point per station name: the first item, averaged with same-name items nearby
        a = (float(rows[0]['lat']), float(rows[0]['lon']))
        near = [r for r in rows if km(a, (float(r['lat']), float(r['lon']))) < 1.2]
        hit = dict(near[0], lat=sum(float(r['lat']) for r in near) / len(near), lon=sum(float(r['lon']) for r in near) / len(near), ja=name)
        found.setdefault(name, hit)
    for key, ko, aliases, emoji, cands in CURATED:
        hit = next((found[l] for l in cands if l in found), None)
        if not hit:
            missing.append(key)
            continue
        ja = re.sub(r'\s*\(.*?\)$', '', hit['ja'])
        if ja.endswith('駅') and not cands[0].endswith('駅'):
            ja = re.sub(r'\s*\(.*?\)$', '', cands[0])   # placed at a station, named as the place
        out.append({'k': key, 'ko': ko, 'al': aliases, 'e': emoji, 'ja': ja,
                    'lat': round(float(hit['lat']), 6), 'lon': round(float(hit['lon']), 6), 'wd': hit['item'].rsplit('/', 1)[1], 't': 'sight'})
    for ko, aliases, emoji, st in AREAS:
        hit = found.get(re.sub(r'\s*\(.*?\)$', '', st))
        if not hit:
            missing.append(ko)
            continue
        sj = re.sub(r'\s*\(.*?\)$', '', hit['ja'])
        out.append({'k': 'area-' + ko, 'ko': ko, 'al': aliases, 'e': emoji, 'ja': re.sub(r'^(大阪メトロ|JR|近鉄|南海|阪急|阪神|京阪)', '', sj), 'st': sj,
                    'lat': round(float(hit['lat']), 6), 'lon': round(float(hit['lon']), 6), 'wd': hit['item'].rsplit('/', 1)[1], 't': 'area'})
    # every station in central Osaka (one entry per name; operators' separate items merged when close)
    seen = []
    for r in st_rows:
        ja = re.sub(r'\s*\(.*?\)$', '', r['ja'])
        if not ja.endswith('駅'):
            continue
        p = (float(r['lat']), float(r['lon']))
        if not (34.60 <= p[0] <= 34.76 and 135.40 <= p[1] <= 135.58):
            continue
        if any(s['ja'] == ja and km(p, (s['lat'], s['lon'])) < 0.8 for s in seen):
            continue
        ko = clean_ko(r.get('ko')) or None
        en = clean_ko(r.get('en')) or None
        if not ko:
            continue
        seen.append({'k': 'st-' + r['item'].rsplit('/', 1)[1], 'ko': ko, 'al': [x for x in (en,) if x], 'e': '🚉', 'ja': ja,
                     'lat': round(p[0], 6), 'lon': round(p[1], 6), 'wd': r['item'].rsplit('/', 1)[1], 't': 'station'})
    out += seen
    OUT.write_text(json.dumps({'source': 'Wikidata (CC0) — coordinates and Japanese labels; Korean names for landmarks curated',
                               'builtOn': time.strftime('%Y-%m-%d'), 'places': out}, ensure_ascii=False, indent=0), encoding='utf-8')
    print(f'{len(out)} places ({len(seen)} stations); not found on Wikidata: {missing}')


if __name__ == '__main__':
    main()
