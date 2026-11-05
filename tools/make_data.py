"""Merge the v3 restaurant list with the 2026-11-05 web verification into src/data.json.

Usage: python3 -I tools/make_data.py <map_v3.html> <data_verification.json>
"""
import json
import re
import sys
from pathlib import Path

v3_html, verify_json = sys.argv[1], sys.argv[2]
html = Path(v3_html).read_text(encoding="utf-8")
m = re.search(r"const DATA=(\[.*?\]);\n", html, re.S)
base = json.loads(m.group(1))
verified = {v["id"]: v for v in json.loads(Path(verify_json).read_text(encoding="utf-8"))}

# Opening hours for the trip days (Fri 11/13, Sat 11/14, Sun 11/15), from the verification pass.
# [] = closed that day, None = unknown. "24:00" means midnight.
A = lambda *r: [list(x) for x in r]
L1 = ("11:00", "15:00")
HOURS = {
    1: dict(fri=A(("11:00", "15:30")), sat=A(("11:00", "16:00"), ("18:00", "21:00")), sun=A(("11:00", "16:00")),
            closed="화요일", warn="토요일 저녁은 X(트위터) 사전 예약제"),
    2: dict(fri=A(("11:30", "14:30"), ("18:00", "21:00")), sat=A(("11:30", "14:30"), ("18:00", "21:00")), sun=[],
            closed="일요일·공휴일", warn="면이 다 떨어지면 일찍 마감"),
    3: dict(fri=A(("11:00", "15:00"), ("17:30", "20:00")), sat=A(L1), sun=A(L1),
            closed="비정기 (공식 홈페이지에 월별 공지)", warn="휴무일이 매달 달라요. 가기 전 공식 홈페이지 확인"),
    4: dict(fri=A(("12:00", "16:00")), sat=A(("12:00", "20:00")), sun=A(("12:00", "20:00")),
            closed="화요일, 첫째·셋째·다섯째 수요일"),
    5: dict(fri=A(L1, ("18:00", "21:00")), sat=A(L1, ("18:00", "21:00")), sun=A(("11:00", "16:00")),
            closed="월요일", warn="카운터 9석"),
    6: dict(**{d: A(L1, ("17:00", "21:30")) for d in ("fri", "sat", "sun")}, closed="연중무휴"),
    7: dict(**{d: A(("10:00", "15:00")) for d in ("fri", "sat", "sun")},
            closed="화요일", warn="2026년 봄에 금요일 임시휴무가 있었음"),
    8: dict(**{d: A(L1, ("18:00", "22:00")) for d in ("fri", "sat", "sun")}, closed="연중무휴"),
    9: dict(**{d: A(("11:00", "21:30")) for d in ("fri", "sat", "sun")}, closed="LUCUA 휴관일에 따름"),
    10: dict(**{d: A(("11:30", "21:30")) for d in ("fri", "sat", "sun")}, closed="목요일"),
    11: dict(**{d: A(("16:00", "23:00")) for d in ("fri", "sat", "sun")}, closed="연말연시, 8월"),
    12: dict(fri=A(("11:00", "14:30"), ("16:00", "24:00")), sat=A(("12:00", "24:00")), sun=A(("12:00", "24:00")),
             closed="월요일", warn="평일 점심은 함박스테이크만"),
    13: dict(**{d: A(("16:00", "24:00")) for d in ("fri", "sat", "sun")},
             closed="월요일·공휴일", warn="예약이 약 2개월 밀려 있다는 후기 있음"),
    14: dict(fri=A(("05:00", "14:00")), sat=A(("05:00", "14:00")), sun=[], closed="일요일·공휴일"),
    15: dict(**{d: A(("11:00", "22:00")) for d in ("fri", "sat", "sun")}, closed="한큐삼번가 휴관일에 따름"),
    16: dict(**{d: A(("11:30", "15:00"), ("18:00", "21:00")) for d in ("fri", "sat", "sun")}, closed="수요일"),
    17: dict(**{d: A(("10:30", "14:30")) for d in ("fri", "sat", "sun")},
             closed="화요일", warn="예전 정보에는 금요일도 휴무. 재료 소진 시 마감"),
    18: dict(fri=A(("11:30", "21:30")), sat=A(("11:00", "21:30")), sun=A(("11:00", "21:30")), closed="정보 없음"),
    19: dict(**{d: A(("11:00", "22:30")) for d in ("fri", "sat", "sun")},
             closed="셋째 화요일", warn="긴테쓰 오사카난바역 개찰구 안쪽"),
    20: dict(fri=A(("11:30", "22:00")), sat=A(("11:00", "22:00")), sun=A(("11:00", "21:00")),
             closed="비정기", warn="20:00에 닫는다는 정보도 있음"),
    21: dict(fri=A(("17:00", "23:30")), sat=A(("12:00", "23:30")), sun=A(("12:00", "23:30")),
             closed="연말연시", warn="평일은 저녁만 영업"),
    22: dict(**{d: A(("10:00", "21:45")) for d in ("fri", "sat", "sun")}, closed="연중무휴"),
    23: dict(fri=A(("11:00", "22:30")), sat=A(("11:00", "22:30")), sun=A(("11:00", "22:00")), closed="월요일"),
    24: dict(**{d: A(("11:30", "21:30")) for d in ("fri", "sat", "sun")}, closed="수요일, 넷째 화요일"),
    25: dict(**{d: A(("12:00", "15:00"), ("18:00", "24:00")) for d in ("fri", "sat", "sun")}, closed="수요일"),
    26: dict(fri=A(("17:00", "23:00")), sat=A(("17:00", "23:00")), sun=[], closed="월·목·일요일, 공휴일"),
    27: dict(**{d: A(("09:00", "20:00")) for d in ("fri", "sat", "sun")},
             closed="정보 없음", warn="1층 매장 기준. 2층 카페는 11:30–18:00(금)/19:00(토·일)"),
    28: dict(fri=None, sat=None, sun=None, closed="연중무휴",
             warn="영업시간이 출처마다 달라요 (대략 10:00–21:00)"),
    29: dict(**{d: A(("11:30", "21:30")) for d in ("fri", "sat", "sun")}, closed="정보 없음"),
    30: dict(**{d: A(("08:00", "23:00")) for d in ("fri", "sat", "sun")}, closed="1월 1일"),
}

SEAT = {  # v3 seat text -> (tag, short label)
    "대기·소규모": ("hard", "6인 어려움"),
    "6명 이상 전화 예약 가능": ("reserve", "6인 전화 예약"),
    "예약 추천": ("reserve", "예약 추천"),
    "대기 확인": ("check", "좌석 확인"),
    "4명 이상 예약 불가·현장 대기": ("hard", "현장 대기"),
    "예약 확인": ("check", "예약 확인"),
    "6인 비교적 유리": ("ok", "6인 OK"),
    "포장 추천": ("takeout", "포장 추천"),
}
EMOJI = {"라멘": "🍜", "우동": "🍲", "카레": "🍛", "오코노미야키": "🥞", "오뎅": "🍢", "야키니쿠": "🥩",
         "스시": "🍣", "양식": "🍳", "카페·디저트": "☕", "타코야키": "🐙"}

out = []
for r in base:
    v = verified[r["id"]]
    tag, label = SEAT[r["seat"]]
    rating_now = v.get("tabelog_now")
    tabelog = rating_now if isinstance(rating_now, (int, float)) else r["tabelog"]
    image = r["image"]
    if "assets.st-note.com" in image:
        image = re.sub(r"width=\d+", "width=640", re.sub(r"height=\d+", "height=640", image))
    h = HOURS[r["id"]]
    out.append({
        "id": r["id"],
        "name": r["name"],
        "jp": r["jp"],
        "region": "north" if r["area"] == "우메다·후쿠시마" else "south",
        "area": r["area"],
        "kind": r["kind"],
        "emoji": EMOJI[r["kind"]],
        "tabelog": tabelog,
        "google": r["google"],
        "seat": r["seat"],
        "seatTag": tag,
        "seatLabel": label,
        "desc": r["desc"],
        "address": "大阪府大阪市中央区日本橋1-16-4" if r["id"] == 26 else r["address"],
        "lat": round(v["verified_lat"], 6),
        "lon": round(v["verified_lon"], 6),
        "coordConf": v.get("confidence"),
        "image": image,
        "credit": r["credit"],
        "tabelogUrl": r["tabelogUrl"],
        "fav": bool(r["favoriteDefault"]),
        "hours": {d: h.get(d) for d in ("fri", "sat", "sun")},
        "closed": h.get("closed"),
        "warn": h.get("warn"),
    })

hotel = {"name": "리가 로열 호텔 오사카", "jp": "リーガロイヤルホテル大阪", "lat": 34.6903, "lon": 135.4873,
         "address": "大阪府大阪市北区中之島5-3-68"}
Path("src/data.json").write_text(json.dumps({"verifiedOn": "2026-11-05", "hotel": hotel, "restaurants": out},
                                            ensure_ascii=False, indent=1), encoding="utf-8")
print(len(out), "restaurants written")
