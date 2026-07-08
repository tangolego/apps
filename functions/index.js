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
// Hosting 리라이트를 거치면 원래 경로(/api/...)가 그대로 전달되고,
// Cloud Functions 주소를 직접 호출하면 함수 이름(api) 세그먼트가 빠진 채(/...) 전달된다.
// 두 경우 다 동작하도록 같은 라우터를 루트와 /api 양쪽에 등록한다.
app.use(api);
app.use("/api", api);

// ---------------------------------------------------------------------------
// GET /proxy?url=<용인시 재난CCTV 스트림 서버 주소>
//
// safe.yongin.go.kr/m/cctv_view.html 이 HTTP(비보안)라 HTTPS 페이지에서 바로
// <video>로 못 여는(mixed content) 문제 + hls.js가 CORS 없이 못 읽는 문제를
// 우회하기 위한 중계용 프록시. 아무 URL이나 열어주면 오픈 릴레이가 되니
// yongin.go.kr 스트림 서버 호스트로만 엄격히 제한한다.
// ---------------------------------------------------------------------------
const ALLOWED_STREAM_HOSTS = new Set(["safe.yongin.go.kr", "safe2.yongin.go.kr"]);

function isAllowedStreamUrl(u) {
  try {
    const parsed = new URL(u);
    return (
      parsed.protocol === "http:" &&
      ALLOWED_STREAM_HOSTS.has(parsed.hostname) &&
      parsed.port === "1935" &&
      parsed.pathname.startsWith("/live/")
    );
  } catch {
    return false;
  }
}

api.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target || !isAllowedStreamUrl(target)) {
    return res.status(400).json({ error: "허용되지 않은 스트림 주소예요." });
  }

  let upstream;
  try {
    upstream = await fetch(target, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    return res.status(502).json({ error: "스트림 서버에 연결하지 못했어요: " + err.message });
  }

  if (!upstream.ok) {
    return res.status(502).json({ error: "스트림 서버 응답 오류: " + upstream.status });
  }

  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cache-Control", "no-cache");

  const isPlaylist = target.endsWith(".m3u8");

  if (isPlaylist) {
    // m3u8은 텍스트라서, 그 안의 세그먼트/하위 플레이리스트 줄들을
    // 전부 "우리 프록시를 거치는 절대 URL"로 바꿔써야 다음 요청도 프록시를 탄다.
    const text = await upstream.text();
    const rewritten = text
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line; // 태그/주석 줄은 그대로
        const absolute = new URL(trimmed, target).href; // 상대경로 -> 절대경로
        return `/api/proxy?url=${encodeURIComponent(absolute)}`;
      })
      .join("\n");
    res.set("Content-Type", "application/vnd.apple.mpegurl");
    return res.send(rewritten);
  }

  // .ts 세그먼트 등 바이너리는 그대로 스트리밍
  res.set("Content-Type", upstream.headers.get("content-type") || "video/mp2t");
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.send(buf);
});

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
exports.hlsProxy = require('./hlsProxy').hlsProxy;