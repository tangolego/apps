# Firebase Functions + Firestore 백엔드 (SQLite 대체)

이 폴더들을 **기존 레포에 병합**해주세요. 통째로 덮어쓰지 마시고, 아래 순서대로 합쳐주세요.

## 1. 기존 레포에 합치기

```
wifi-map-backend(레포)/
├── functions/              ← 이번에 새로 추가 (전체 폴더)
├── public/                 ← 기존 것 그대로 유지 (index.html, 10.html 등)
├── firebase.json           ← 기존 파일에 "functions"/"firestore" 항목만 추가 병합
├── firestore.rules         ← 새로 추가
└── firestore.indexes.json  ← 새로 추가
```

기존 `firebase.json`에 이미 `"hosting"` 항목이 있다면, 거기에 `rewrites` 배열만 추가해주세요:

```json
{
  "hosting": {
    "public": "public",
    "rewrites": [
      { "source": "/api/**", "function": { "functionId": "api", "region": "asia-northeast3" } }
    ]
  },
  "functions": [{ "source": "functions" }],
  "firestore": { "rules": "firestore.rules", "indexes": "firestore.indexes.json" }
}
```

## 2. Firestore 활성화 (최초 1회, 콘솔에서)

Firebase 콘솔 → `wifimap-852eb` 프로젝트 → **Firestore Database** → 데이터베이스 만들기
→ 리전은 `asia-northeast3(서울)` 선택 (함수 리전과 통일해야 지연시간이 적어요).

## 3. 배포

```bash
cd functions
npm install
cd ..
firebase deploy --only functions,firestore,hosting
```

배포되면 API는 다음 주소로 열려요 (Hosting 리라이트 덕분에 별도 CORS 설정 없이 같은 오리진에서 호출 가능):

```
https://wifimap-852eb.web.app/api/spots?lat=...&lng=...&radius=...
https://wifimap-852eb.web.app/api/public-wifi?limit=50
https://wifimap-852eb.web.app/api/spots/search?q=...
POST https://wifimap-852eb.web.app/api/spots
```

## 4. 프론트엔드 쪽 수정

`wifi-map-ait-source.zip`의 `frontend/src/api/wifi.ts`에서 `API_BASE`를 이걸로 바꿔주세요:

```ts
const API_BASE = import.meta.env.VITE_API_BASE || "https://wifimap-852eb.web.app/api";
```

바꾼 뒤 `npx ait build`로 `.ait` 다시 뽑으면 돼요. 원하시면 제가 바로 반영해서 새 `.ait` 만들어드릴게요.

## 5. 공공 와이파이 데이터 넣기 (최초 1회 + 주기적 재실행)

```bash
cd functions
npm install   # csv-parse, iconv-lite 포함해서 설치
```

Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → **새 비공개 키 생성** → JSON 다운로드 후:

```bash
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json node scripts/import-public-wifi.js
```

같은 장소는 결정적 ID로 upsert되니 몇 번을 다시 돌려도 중복 생성되지 않아요. 크론으로 주기 실행해도 안전해요.

## 6. CCTV 10개 지점 (Firestore 기반)

`cctv_spots` 컬렉션으로 별도 관리돼요 (`wifi_spots`와 무관).

```
GET   /api/cctv-spots           # 10개 지점 목록
PATCH /api/cctv-spots/:id       # 마커 드래그로 보정한 좌표 저장 { lat, lng }
```

최초 1회, 서비스 계정 키로 시드:

```bash
cd functions
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json node scripts/seed-cctv-spots.js
```

이미 있는 문서는 건드리지 않아서 몇 번을 다시 돌려도 안전해요 (드래그로 보정한 좌표가 덮어써지지 않음).

프론트 페이지는 `public/10.html`이고, `localStorage` 대신 이 API를 통해 Firestore에서 읽고/씁니다 —
즉 어떤 브라우저/기기로 보정하든 **모든 사용자에게 공유**돼요.

## SQLite 버전과 달라진 점 (알아두세요)

| 기능 | SQLite 버전 | Firestore 버전 |
|---|---|---|
| 반경 검색 | geohash 셀 + SQL | geohash 셀 + Firestore `in` 쿼리 (최대 9셀) |
| 건물명 검색 | `LIKE '%q%'` (부분 일치) | `>=`/`<=` 범위 쿼리 (**앞부분 일치만** 지원 — 부분 포함 검색은 안 됨) |
| 인증/보안 | CORS만 열어둠 | Firestore 규칙으로 클라이언트 직접 접근 전면 차단, Functions(Admin SDK)만 접근 |
| 배포 | 별도 서버 필요 | Firebase 하나로 통합 (Hosting + Functions + Firestore) |

건물명 검색이 "포함" 검색이 꼭 필요하시면, 나중에 Algolia/Typesense 연동으로 업그레이드하는 방법도 있어요 — 지금은 일단 이 정도로 두고, 필요해지면 말씀해주세요.
