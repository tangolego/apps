/**
 * functions/hlsProxy.js
 * -----------------------------------------------------------------------
 * 용인시 CCTV HLS 스트림(http://{host}.yongin.go.kr:1935/...)을
 * HTTPS로 그대로 중계하는 프록시입니다.
 *
 * 왜 필요한가:
 *  - 우리 페이지는 https://wifimap-852eb.web.app (HTTPS)
 *  - CCTV 스트림 서버는 http:// 만 지원 (포트 1935)
 *  - iOS WebKit(Safari/Chrome-on-iOS 전부 동일 엔진)이 이 믹스드 콘텐츠를
 *    엄격히 차단해서 재생 자체가 안 됨 (데스크톱 크롬은 상대적으로 관대해서 됨)
 *
 * 동작 방식:
 *  - /hlsProxy/ch58_s.stream/playlist.m3u8 로 요청이 오면
 *  - http://safe2.yongin.go.kr:1935/live/ch58_s.stream/playlist.m3u8 를
 *    서버(Node) 쪽에서 대신 가져와서 그대로 돌려줌 (안 되면 safe로 재시도)
 *  - .m3u8 안의 세그먼트 경로가 상대경로라서, 플레이어가 세그먼트도
 *    자동으로 같은 프록시 경로(/hlsProxy/ch58_s.stream/media_xxx.ts)로
 *    요청하게 되고, 이것도 이 함수가 그대로 중계함 (본문 재작성 불필요)
 *
 * 배포 방법:
 *  1) 이 파일을 기존 functions 프로젝트의 index.js에 이어붙이거나,
 *     별도 파일로 두고 index.js에서 require해서 exports 하세요.
 *  2) firebase deploy --only functions:hlsProxy
 *  3) firebase.json의 hosting rewrites에 아래를 추가해서
 *     /hlsProxy/** 경로를 이 함수로 연결하세요:
 *
 *     "rewrites": [
 *       { "source": "/hlsProxy/**", "function": "hlsProxy" }
 *     ]
 *
 *     이렇게 하면 프록시도 같은 도메인(wifimap-852eb.web.app)에서
 *     서빙되니 CORS 걱정도 없습니다.
 */

const { onRequest } = require('firebase-functions/v2/https');

const STREAM_HOSTS = ['safe2', 'safe'];
const UPSTREAM_PORT = 1935;

// 확장자별 정확한 Content-Type 지정 (iOS 네이티브 HLS가 이 헤더를 깐깐하게 봄)
function contentTypeFor(path) {
  if (path.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (path.endsWith('.ts')) return 'video/mp2t';
  return 'application/octet-stream';
}

async function fetchFromHost(host, path) {
  const upstreamUrl = `http://${host}.yongin.go.kr:${UPSTREAM_PORT}/live/${path}`;
  const res = await fetch(upstreamUrl, {
    // 스트림 서버가 응답을 오래 끄는 경우를 대비한 타임아웃
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`upstream ${host} responded ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer;
}

exports.hlsProxy = onRequest(
  { cors: true, region: 'asia-northeast3' }, // 서울 리전 (레이턴시 최소화)
  async (req, res) => {
    // 기대하는 경로 형태: /hlsProxy/ch58_s.stream/playlist.m3u8
    const path = req.path.replace(/^\/hlsProxy\//, '').replace(/^\//, '');
    if (!path) {
      res.status(400).send('missing stream path');
      return;
    }

    let lastError = null;
    for (const host of STREAM_HOSTS) {
      try {
        const buffer = await fetchFromHost(host, path);
        res.set('Content-Type', contentTypeFor(path));
        res.set('Cache-Control', 'no-store'); // 라이브 스트림이라 캐시 금지
        res.set('Access-Control-Allow-Origin', '*');
        res.status(200).send(buffer);
        return;
      } catch (err) {
        lastError = err;
        // 다음 host로 계속 시도
      }
    }

    console.error('hlsProxy failed for path:', path, lastError);
    res.status(502).send('stream unavailable');
  }
);
