const geohash = require("ngeohash");

// 격자 정밀도: 6자리 geohash ≈ 가로 1.2km x 세로 0.6km 칸.
// (원래 SQLite 버전의 "건물 단위" 익명화 의도를 유지하면서, Firestore에서
//  in-쿼리로 반경 검색을 하기 위한 절충 정밀도)
const GEOHASH_PRECISION = 6;

function cellKey(lat, lng) {
  return geohash.encode(lat, lng, GEOHASH_PRECISION);
}

// 주어진 좌표를 중심으로 3x3 이웃 셀(자기 자신 포함) 목록을 반환.
// Firestore 'in' 쿼리는 최대 10개 값까지 지원하므로 9개는 안전.
function neighborCellKeys(lat, lng) {
  const center = cellKey(lat, lng);
  const neighbors = geohash.neighbors(center); // [n, ne, e, se, s, sw, w, nw]
  return [center, ...neighbors];
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// 건물 단위로만 위치를 쓰기 위해, 소수점 넷째 자리(약 11m)에서 반올림.
// (완전한 실시간 정밀 좌표를 그대로 저장하지 않기 위한 최소수집 조치)
function snapToBuildingGrid(lat, lng) {
  const round = (v) => Math.round(v * 10000) / 10000;
  return { lat: round(lat), lng: round(lng) };
}

module.exports = { cellKey, neighborCellKeys, haversineMeters, snapToBuildingGrid, GEOHASH_PRECISION };
