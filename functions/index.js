const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const express = require("express");
const {
  cellKey,
  neighborCellKeys,
  haversineMeters,
  snapToBuildingGrid,
} = require("./lib/geo");

admin.initializeApp();
const db = admin.firestore();
const spotsCol = db.collection("wifi_spots");
const cctvCol = db.collection("cctv_spots");

// setGlobalOptions 대신 이 함수(api) 전용 옵션을 onRequest에 직접 지정한다.
// (이전엔 setGlobalOptions로 전역 설정했는데, 이러면 hlsProxy.js의 스트리밍
//  트래픽과 여기 wifi/cctv 검색 API가 같은 maxInstances 풀을 나눠 쓰게 되어
//  CCTV 시청자가 몰릴 때 검색 API가 함께 지연되는 문제가 있었다.)
const REGION = "asia-northeast3"; // 서울 리전

const app = express();
app.use(express.json());
const api = express.Router();
// Hosting 리라이트를 거치면 원래 경로(/api/...)가 그대로 전달되고,
// Cloud Functions 주소를 직접 호출하면 함수 이름(api) 세그먼트가 빠진 채(/...) 전달된다.
// 두 경우 다 동작하도록 같은 라우터를 루트와 /api 양쪽에 등록한다.
app.use(api);
app.use("/api", api);

// ---------------------------------------------------------------------------
// 참고: 용인시 CCTV HLS 프록시는 이 파일이 아니라 hlsProxy.js에만 구현되어 있다.
// (프론트엔드 public/index.html은 /hlsProxy/... 경로만 사용하며, 예전에 여기
//  있던 /api/proxy 라우트는 실제로 호출되지 않는 중복 구현이라 제거했다.
//  같은 로직이 두 곳에 있으면 한쪽만 고쳤을 때 갈라질 위험이 있고, 별도
//  함수가 하나 더 배포되어 콜드스타트 경로도 늘어난다.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// POST /spots  (제보 등록)
// ---------------------------------------------------------------------------
api.post("/spots", async (req, res) => {
  const { buildingName, coords, ssid, hasPassword, reporterId } = req.body || {};

  if (!buildingName || !ssid || !reporterId) {
    return res.status(400).json({ error: "buildingName, ssid, reporterId는 필수예요." });
  }

  const hasCoords = coords && typeof coords.lat === "number" && typeof coords.lng === "number";
  const snapped = hasCoords ? snapToBuildingGrid(coords.lat, coords.lng) : null;

  const doc = {
    buildingName: String(buildingName).slice(0, 100),
    buildingNameLower: String(buildingName).toLowerCase().slice(0, 100),
    lat: snapped ? snapped.lat : null,
    lng: snapped ? snapped.lng : null,
    geohash6: snapped ? cellKey(snapped.lat, snapped.lng) : null,
    locationType: hasCoords ? "gps" : "manual",
    source: "community",
    ssid: String(ssid).slice(0, 60),
    hasPassword: !!hasPassword,
    isPubliclyPosted: true,
    reporterId: String(reporterId).slice(0, 100),
    trustScore: 0,
    status: "active",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const ref = await spotsCol.add(doc);
  res.json({ id: ref.id });
});

// ---------------------------------------------------------------------------
// GET /public-wifi?limit=&offset=  (위치 없이 공공 와이파이만 나열)
// ---------------------------------------------------------------------------
api.get("/public-wifi", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  let query = spotsCol
    .where("status", "==", "active")
    .where("source", "==", "public")
    .orderBy("buildingName")
    .limit(limit);

  // 커서 기반 페이지네이션 (offset 대신 마지막으로 받은 buildingName을 넘겨받음)
  const after = req.query.after;
  if (after) query = query.startAfter(after);

  const snap = await query.get();
  const spots = snap.docs.map((d) => toClientSpot(d));

  res.json({
    limit,
    nextAfter: spots.length === limit ? spots[spots.length - 1].buildingName : null,
    spots,
  });
});

// ---------------------------------------------------------------------------
// GET /spots?lat=&lng=&radius=  (반경 내 활성 스팟 조회, 공공+커뮤니티)
// ---------------------------------------------------------------------------
// 밀집 지역(셀 하나에 문서가 아주 많은 경우)에서 읽기 비용과 응답 시간이
// 무한정 늘어나지 않도록, 거리 필터링 이전 단계에서 쿼리 자체에 상한을 둔다.
// 이 상한보다 셀 안에 문서가 많으면 먼 것부터 누락될 수 있지만, 애초에
// radius 파라미터로 사용자가 좁은 범위를 요청한 것이므로 실사용에서는
// 이 상한에 걸릴 일이 거의 없다.
const SPOTS_QUERY_LIMIT = 300;

api.get("/spots", async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radius = Number(req.query.radius) || 500;

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: "lat, lng는 필수예요." });
  }

  const cells = neighborCellKeys(lat, lng); // 최대 9개, Firestore 'in' 한도(10) 이내

  const snap = await spotsCol
    .where("status", "==", "active")
    .where("geohash6", "in", cells)
    .limit(SPOTS_QUERY_LIMIT)
    .get();

  const spots = snap.docs
    .map((d) => toClientSpot(d))
    .filter((s) => s.coords) // geohash6가 없는(수동 등록) 스팟은 반경검색에서 제외
    .map((s) => ({ ...s, distanceM: haversineMeters(lat, lng, s.coords.lat, s.coords.lng) }))
    .filter((s) => s.distanceM <= radius)
    .sort((a, b) => a.distanceM - b.distanceM)
    .map((s) => ({ ...s, distanceM: Math.round(s.distanceM) }));

  res.json(spots);
});

// ---------------------------------------------------------------------------
// GET /spots/search?q=  (건물명 검색 — 앞부분 일치 검색만 지원)
// ---------------------------------------------------------------------------
api.get("/spots/search", async (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();
  if (!q) return res.json([]);

  // Firestore는 부분(포함) 문자열 검색을 지원하지 않아서 "시작 문자열" 검색만 가능해요.
  // (SQLite의 LIKE '%q%'와는 다름 — 필요하면 Algolia/Typesense 연동으로 업그레이드 가능)
  const snap = await spotsCol
    .where("status", "==", "active")
    .where("buildingNameLower", ">=", q)
    .where("buildingNameLower", "<=", q + "\uf8ff")
    .limit(50)
    .get();

  res.json(snap.docs.map((d) => toClientSpot(d)));
});

// ---------------------------------------------------------------------------
// GET /cctv-spots  (10개 CCTV 지점 목록)
// ---------------------------------------------------------------------------
api.get("/cctv-spots", async (req, res) => {
  const snap = await cctvCol.orderBy("name").get();
  res.json(snap.docs.map((d) => toClientCctvSpot(d)));
});

// ---------------------------------------------------------------------------
// PATCH /cctv-spots/:id  (마커 드래그로 위치 보정 저장)
// ---------------------------------------------------------------------------
api.patch("/cctv-spots/:id", async (req, res) => {
  const { lat, lng } = req.body || {};
  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "lat, lng(숫자)는 필수예요." });
  }

  const ref = cctvCol.doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: "해당 지점을 찾을 수 없어요." });

  await ref.update({
    lat,
    lng,
    positionSource: "corrected", // 최초 추정치(estimated)와 구분
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  res.json({ ok: true });
});

function toClientCctvSpot(doc) {
  const d = doc.data();
  return {
    id: doc.id,
    name: d.name,
    address: d.address,
    coords: { lat: d.lat, lng: d.lng },
    videoUrl: d.videoUrl,
    verified: !!d.verified,
    positionSource: d.positionSource || "estimated",
  };
}
function toClientSpot(doc) {
  const d = doc.data();
  return {
    id: doc.id,
    buildingName: d.buildingName,
    coords: d.lat != null ? { lat: d.lat, lng: d.lng } : null,
    locationType: d.locationType,
    source: d.source,
    ssid: d.ssid,
    hasPassword: !!d.hasPassword,
    trustScore: d.trustScore || 0,
    updatedAt: d.updatedAt ? d.updatedAt.toDate().toISOString() : null,
  };
}

// 이 함수(wifi/cctv 검색 API) 전용 옵션. hlsProxy.js는 자체 maxInstances(30)를
// 가지므로, 여기서 10으로 지정해도 스트리밍 트래픽에 잠식되지 않는다.
exports.api = onRequest({ region: REGION, maxInstances: 10 }, app);
exports.hlsProxy = require('./hlsProxy').hlsProxy;