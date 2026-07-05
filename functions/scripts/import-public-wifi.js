/**
 * 행정안전부 "전국무료와이파이표준데이터"를 다운로드해서 Firestore wifi_spots 컬렉션에
 * source: 'public'으로 upsert하는 1회성 스크립트.
 *
 * 실행 전 준비:
 *   1. Firebase 콘솔 > 프로젝트 설정 > 서비스 계정 > 새 비공개 키 생성 (JSON 다운로드)
 *   2. GOOGLE_APPLICATION_CREDENTIALS 환경변수로 그 JSON 경로 지정
 *   3. npm install (devDependencies 포함: csv-parse, iconv-lite)
 *
 * 실행:
 *   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json node scripts/import-public-wifi.js
 */
const admin = require("firebase-admin");
const iconv = require("iconv-lite");
const { parse } = require("csv-parse/sync");
const { cellKey, snapToBuildingGrid } = require("../lib/geo");

const SOURCE_URL = "https://file.localdata.go.kr/file/free_wifi_info/info";

// 원본 CSV 컬럼명이 지자체마다 조금씩 다를 수 있어서, 후보 목록 중 매칭되는 걸 사용한다.
const COLUMN_CANDIDATES = {
  name: ["설치장소명", "설치장소", "시설명", "장소명"],
  ssid: ["WIFI명", "AP명", "와이파이명", "SSID"],
  lat: ["위도", "Y좌표", "설치위도"],
  lng: ["경도", "X좌표", "설치경도"],
};

function pickColumn(headerRow, candidates) {
  return candidates.find((c) => headerRow.includes(c));
}

async function main() {
  admin.initializeApp();
  const db = admin.firestore();
  const spotsCol = db.collection("wifi_spots");

  console.log("공공 와이파이 데이터 다운로드 중...", SOURCE_URL);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error("다운로드 실패: " + res.status);

  const buffer = Buffer.from(await res.arrayBuffer());
  // 정부 표준데이터는 보통 EUC-KR 인코딩이라 UTF-8로 변환.
  const text = iconv.decode(buffer, "EUC-KR");

  const records = parse(text, { columns: true, skip_empty_lines: true });
  if (records.length === 0) throw new Error("파싱된 행이 없어요. CSV 포맷을 확인해주세요.");

  const header = Object.keys(records[0]);
  const col = {
    name: pickColumn(header, COLUMN_CANDIDATES.name),
    ssid: pickColumn(header, COLUMN_CANDIDATES.ssid),
    lat: pickColumn(header, COLUMN_CANDIDATES.lat),
    lng: pickColumn(header, COLUMN_CANDIDATES.lng),
  };
  console.log("감지된 컬럼:", col);

  if (!col.name || !col.lat || !col.lng) {
    throw new Error(
      "필수 컬럼(설치장소명/위도/경도)을 찾지 못했어요. 실제 헤더: " + header.join(", ")
    );
  }

  let batch = db.batch();
  let batchCount = 0;
  let imported = 0;
  let skipped = 0;

  for (const row of records) {
    const lat = parseFloat(row[col.lat]);
    const lng = parseFloat(row[col.lng]);
    const name = (row[col.name] || "").trim();

    if (!name || Number.isNaN(lat) || Number.isNaN(lng)) {
      skipped++;
      continue;
    }

    const snapped = snapToBuildingGrid(lat, lng);
    // 같은 장소 중복 임포트 방지: 이름+좌표로 결정적 ID 생성 (upsert)
    const docId = "public_" + Buffer.from(`${name}_${snapped.lat}_${snapped.lng}`).toString("base64url").slice(0, 60);

    batch.set(
      spotsCol.doc(docId),
      {
        buildingName: name.slice(0, 100),
        buildingNameLower: name.toLowerCase().slice(0, 100),
        lat: snapped.lat,
        lng: snapped.lng,
        geohash6: cellKey(snapped.lat, snapped.lng),
        locationType: "gps",
        source: "public",
        ssid: (col.ssid ? row[col.ssid] : "공공와이파이") || "공공와이파이",
        hasPassword: false,
        isPubliclyPosted: true,
        reporterId: "import-script",
        trustScore: 5,
        status: "active",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    batchCount++;
    imported++;

    // Firestore batch는 최대 500건
    if (batchCount === 500) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
      console.log(`${imported}건 처리 중...`);
    }
  }

  if (batchCount > 0) await batch.commit();

  console.log(`임포트 완료: ${imported}건 성공, ${skipped}건 건너뜀 (좌표/이름 누락)`);
}

main().catch((err) => {
  console.error("임포트 실패:", err.message);
  process.exit(1);
});
