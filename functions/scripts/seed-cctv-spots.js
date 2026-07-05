/**
 * 용인시 재난CCTV 10개 지점을 Firestore cctv_spots 컬렉션에 시드하는 1회성 스크립트.
 *
 * 실행:
 *   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json node scripts/seed-cctv-spots.js
 *
 * 이미 존재하는 문서는 건드리지 않아요 — 앱에서 마커를 드래그해 보정한 좌표가
 * 이 스크립트를 다시 돌려도 덮어써지지 않고 그대로 유지됩니다.
 * 좌표(lat/lng)는 최초 시드 시점 기준 추정치입니다.
 */
const admin = require("firebase-admin");

function viewUrl(cn) {
  return `http://safe.yongin.go.kr/m/cctv_view.html?cn=${cn}&cd=1&ct=3`;
}

// verified: safe.yongin.go.kr에서 채널번호를 직접 클릭해 확인한 3곳만 true.
// 나머지 7곳은 패턴 추정치라 실제와 다를 수 있어요.
const SPOTS = [
  { id: "ch57",  name: "고기동 제1경보국",   address: "경기도 용인시 수지구 고기동 229-14", cn: 57,  verified: false, lat: 37.3020, lng: 127.0790 },
  { id: "ch58",  name: "고기동 제2경보국",   address: "경기도 용인시 수지구 고기동 755-37", cn: 58,  verified: true,  lat: 37.2955, lng: 127.0655 },
  { id: "ch62",  name: "고기계곡 제3경보국", address: "경기도 용인시 수지구 고기동 755-45", cn: 62,  verified: false, lat: 37.2935, lng: 127.0630 },
  { id: "ch63",  name: "고기계곡 제4경보국", address: "경기도 용인시 수지구 고기동 755-37", cn: 63,  verified: false, lat: 37.2958, lng: 127.0660 },
  { id: "ch73",  name: "동막천-고기계곡",    address: "경기도 용인시 수지구 고기동 755",    cn: 73,  verified: false, lat: 37.2975, lng: 127.0700 },
  { id: "ch74",  name: "서분당 IC하부",      address: "경기도 용인시 수지구 고기동 755-45", cn: 74,  verified: false, lat: 37.3060, lng: 127.0860 },
  { id: "ch121", name: "고기교",             address: "경기도 용인시 수지구 고기동 755-45", cn: 121, verified: false, lat: 37.2990, lng: 127.0720 },
  { id: "ch105", name: "말구리고개-2",       address: "경기도 용인시 수지구 고기동 340-7",  cn: 105, verified: false, lat: 37.3140, lng: 127.0820 },
  { id: "ch33",  name: "말구리고개-1",       address: "경기도 용인시 수지구 동천동 687-7",  cn: 33,  verified: true,  lat: 37.3170, lng: 127.0850 },
  { id: "ch106", name: "말구리고개-3",       address: "경기도 용인시 수지구 동천동 689-73", cn: 106, verified: true,  lat: 37.3155, lng: 127.0870 },
];

async function main() {
  admin.initializeApp();
  const db = admin.firestore();
  const col = db.collection("cctv_spots");

  const existingSnap = await col.get();
  const existingIds = new Set(existingSnap.docs.map((d) => d.id));

  const batch = db.batch();
  let created = 0;
  let skipped = 0;

  for (const s of SPOTS) {
    if (existingIds.has(s.id)) {
      skipped++; // 이미 있으면 건드리지 않음 (드래그로 보정한 좌표 보존)
      continue;
    }
    batch.set(col.doc(s.id), {
      name: s.name,
      address: s.address,
      lat: s.lat,
      lng: s.lng,
      videoUrl: viewUrl(s.cn),
      verified: s.verified,
      positionSource: "estimated",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    created++;
  }

  if (created > 0) await batch.commit();
  console.log(`시드 완료: 새로 생성 ${created}건, 이미 존재해서 건너뜀 ${skipped}건`);
}

main().catch((err) => {
  console.error("시드 실패:", err.message);
  process.exit(1);
});
