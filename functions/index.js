const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
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

setGlobalOptions({ region: "asia-northeast3", maxInstances: 10 }); // 서울 리전

const app = express();
app.use(express.json());
const api = express.Router();
app.use("/api", api);

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

exports.api = onRequest(app);
