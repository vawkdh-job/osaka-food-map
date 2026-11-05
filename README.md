# 오사카 미식 지도 (v4)

2026-11-13(금)~15(일) 오사카 여행용 맛집 지도입니다. 휴대폰 사용을 기준으로 만들었습니다.

- 타베로그·구글 평점이 핀에 바로 보이고, 평점에 따라 핀 색이 달라집니다.
- **내 위치**(◎)를 켜면 걸어서 20분 안의 가게를 평점 높은 순으로 보여 줍니다.
- 금·토·일 영업시간과 휴무를 보여 주고, 여행 당일에는 "지금 영업 중"으로 거를 수 있습니다(일본 시간 기준).
- 길찾기를 누르면 Google 지도가 현재 위치에서 출발하는 경로를 엽니다. 가까우면 도보, 멀면 대중교통입니다.
- **구글 지도(기본)**: 구글 지도와 같은 한글 표기를 씁니다(Maps JavaScript API, `language=ko`). 구글 지도를 불러오지 못하면(연결 끊김, 키 문제 등) 아래 한글 OpenFreeMap 지도로 자동 전환합니다.
- **한글 지도 (예비)**:
  - 지명·역·동네 이름을 한국어로 보여 줍니다. OpenStreetMap의 한국어 이름을 쓰고, 한국어 이름이 없으면 일본어로 표시합니다.
  - 역 이름은 일본어를 아래에 함께 적어 현지 표지판과 맞춰 볼 수 있습니다.
  - 맛집 핀이 잘 보이도록 지도 위의 다른 가게·시설 아이콘은 숨겨 두었습니다. 메뉴에서 다시 켤 수 있습니다.
- 내 위치에는 파란 점과 정확도 원이 표시되고, 휴대폰이 허용하면 바라보는 방향도 보여 줍니다.
- 지도 엔진은 구글 지도가 기본이고, 예비는 MapLibre GL(벡터 지도, WebGL)입니다. 예비 순서는 한글 OpenFreeMap → 국토지리원(일본어) → OpenStreetMap → Esri입니다.
- 「지도 미리 저장」은 구글 약관상 구글 지도를 저장하지 않습니다. 대신 예비 지도(한글 OpenFreeMap + 국토지리원)를 저장합니다. 서비스 워커는 구글 지도 관련 주소를 캐시하지 않습니다.
- 오프라인 대비:
  - 메뉴(⋯) → 「지도 미리 저장」을 누르면 우메다·난바 일대 지도를 휴대폰에 저장해 둡니다.
  - 한 번 연 앱 화면은 인터넷이 끊겨도 다시 열립니다.

## 휴대폰에서 쓰는 법

1. 공유받은 `https://…github.io/osaka-food-map/` 주소를 **Safari(아이폰)나 Chrome(안드로이드)** 에서 엽니다.
   - 카카오톡 안에서 열리면 화면 위쪽 안내 띠의 「브라우저로 열기」를 누르세요.
2. 공유 버튼 → **홈 화면에 추가**를 누르면 앱처럼 쓸 수 있습니다.
3. 숙소 Wi-Fi에서 메뉴(⋯) → **지도 미리 저장**을 한 번 눌러 둡니다.
4. 밖에서 ◎를 누르고 위치 권한을 **허용**합니다.

## 파일 구성

| 경로 | 내용 |
|---|---|
| `index.html`, `sw.js`, `manifest.webmanifest`, `icon-*.png`, `vendor/maplibre-gl.*` | 배포되는 사이트 (빌드 결과물) |
| `src/app.html` | 앱 본체 (화면·스타일·동작) |
| `src/data.json` | 식당 30곳 데이터 (좌표·평점·영업시간) |
| `src/config.json` | 구글 지도 브라우저 키 (빌드 시 `index.html`에 들어감) |
| `src/sw.js` | 오프라인 캐시 (서비스 워커) |
| `tools/make_data.py` | v3 데이터와 2026-11-05 웹 검증 결과를 합쳐 `src/data.json`을 만드는 스크립트 |
| `tools/build.mjs` | `src/`와 데이터를 묶어 `index.html`을 만들고 MapLibre를 `vendor/`에 복사하는 스크립트 |
| `tests/e2e.mjs` | 휴대폰 화면 자동 테스트 (Playwright) |
| `tests/mock-vector.mjs` | 테스트용 가짜 OpenFreeMap (스타일·벡터 타일) |

## 고치고 다시 배포하기

```bash
npm install          # 처음 한 번 (maplibre-gl, 테스트용 geojson-vt·vt-pbf)
node tools/build.mjs # src/ 수정 후 index.html 다시 만들기
node tests/e2e.mjs   # 자동 테스트 (지도 서버는 가짜로 대체)
git commit -am "…" && git push
```

식당 정보만 바꿀 때는 `src/data.json`을 고친 뒤 `node tools/build.mjs`를 실행하면 됩니다.

## 구글 지도 키

- **프로젝트**: Google Cloud 프로젝트 `osaka-food-map-11054b0a`의 브라우저용 키를 씁니다.
- **키 제한**:
  - 웹사이트: `https://vawkdh-job.github.io/*`
  - API: Maps JavaScript API만
- **사용량 상한**:
  - 과금 대상 지도 로드를 **하루 1,000회**로 제한했습니다(Google Cloud 콘솔 → 할당량).
  - **월 9,000회**를 넘으면 그달 나머지 기간에는 구글 지도를 막습니다.
    - 매일 07~23시(일본 시간) 매시 정각에 Cloud Scheduler가 Cloud Workflows `maps-monthly-cap`(`tools/gcp/maps-monthly-cap.yaml`)을 실행합니다.
    - 이 작업은 이번 달 사용량을 Cloud Monitoring에서 읽어, 9,000회 이상이면 하루 할당량을 0으로, 아니면 1,000으로 맞춥니다.
    - 막힌 동안에는 앱이 한글 지도(OpenFreeMap)로 자동 전환되고, 다음 달 1일 첫 실행 때 다시 풀립니다.
- **공개 여부**: 키는 페이지 코드에 공개되지만, 위 제한 때문에 다른 사이트에서는 동작하지 않습니다.

## 데이터 출처와 한계

- 좌표·영업시간·타베로그 평점은 2026-11-05에 NAVITIME·MapFan·타베로그 검색 결과로 확인한 값입니다.
- 구글 평점은 이전 조사값입니다.
- 실시간 정보는 아니므로 방문 전 Google 지도·타베로그에서 한 번 더 확인하세요.
- 지도:
  - 기본: Google 지도 (지도 데이터 ©Google)
  - 한글 예비: OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors
  - 예비: 地理院タイル(국토지리원) / OpenStreetMap / Esri
  - CARTO는 2026년부터 API 키가 필요해져 뺐습니다.
- 한국어 지명은 OpenStreetMap에 한국어 이름(`name:ko`)이 등록된 곳만 나옵니다. 큰 역·동네·명소는 대부분 등록돼 있고, 작은 길 이름은 일본어로 나옵니다.
