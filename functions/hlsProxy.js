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
 *  - http://safe2.yongin.go.kr:1935/live/ch58_s.stream/playlist.m3u8 와
 *    http://safe.yongin.go.kr:1935/... 를 동시에(병렬로) 시도해서
 *    먼저 성공하는 쪽을 그대로 스트리밍으로 돌려줌
 *  - .m3u8 안의 세그먼트 경로가 상대경로라서, 플레이어가 세그먼트도
 *    자동으로 같은 프록시 경로(/hlsProxy/ch58_s.stream/media_xxx.ts)로
 *    요청하게 되고, 이것도 이 함수가 그대로 중계함 (본문 재작성 불필요)
 *
 * 성능 관련 설계 (2024 리뷰 반영):
 *  - 응답 바디를 arrayBuffer()로 전부 버퍼링하지 않고, upstream 응답
 *    스트림을 그대로 클라이언트로 pipe한다 (TTFB/메모리 사용량 감소).
 *  - safe2/safe 두 호스트를 순차가 아니라 "동시에" 요청해서 먼저
 *    응답하는 쪽을 쓰고, 진 쪽은 즉시 abort한다 (페일오버 지연 최소화).
 *  - .ts 세그먼트는 한 번 생성되면 내용이 바뀌지 않으므로 짧은 TTL로
 *    캐시를 허용해 동시 시청자가 늘어도 upstream 호출이 늘지 않게 한다.
 *    (.m3u8 플레이리스트는 계속 갱신되므로 no-cache 유지)
 *  - 이 함수는 index.js의 /api 라우터와 별도로 자체 maxInstances를
 *    가진다 (아래 onRequest 옵션 참고) — 스트리밍 트래픽이 몰려도
 *    와이파이 검색 API 인스턴스 풀을 잠식하지 않도록 분리.
 */

const { onRequest } = require('firebase-functions/v2/https');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const STREAM_HOSTS = ['safe2', 'safe'];
const UPSTREAM_PORT = 1935;
const UPSTREAM_TIMEOUT_MS = 6000;

// 확장자별 정확한 Content-Type 지정 (iOS 네이티브 HLS가 이 헤더를 깐깐하게 봄)
function contentTypeFor(path) {
  if (path.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (path.endsWith('.ts')) return 'video/mp2t';
  return 'application/octet-stream';
}

// 세그먼트(.ts)는 불변이므로 짧게라도 캐시 허용, 플레이리스트는 매번 최신이어야 함
function cacheControlFor(path) {
  return path.endsWith('.ts') ? 'public, max-age=4' : 'no-store';
}

async function fetchFromHost(host, path, signal) {
  const upstreamUrl = `http://${host}.yongin.go.kr:${UPSTREAM_PORT}/live/${path}`;
  const res = await fetch(upstreamUrl, { signal });
  if (!res.ok || !res.body) {
    throw new Error(`upstream ${host} responded ${res.status}`);
  }
  return res;
}

// 여러 호스트를 동시에 시도해서 가장 먼저 성공하는 응답을 쓰고,
// 나머지는 즉시 abort한다 (순차 재시도 대비 최악 지연을 절반 이하로 줄임).
async function fetchFromAnyHost(path) {
  const controllers = STREAM_HOSTS.map(() => new AbortController());
  const timeouts = controllers.map((c) =>
    setTimeout(() => c.abort(new Error('timeout')), UPSTREAM_TIMEOUT_MS)
  );

  const attempts = STREAM_HOSTS.map((host, i) =>
    fetchFromHost(host, path, controllers[i].signal).then((res) => ({ host, res }))
  );

  try {
    const winner = await Promise.any(attempts);
    // 이긴 것 빼고 나머지는 취소
    controllers.forEach((c, i) => {
      if (STREAM_HOSTS[i] !== winner.host) c.abort(new Error('lost race'));
    });
    return winner;
  } catch (aggErr) {
    // 전부 실패한 경우 AggregateError로 옴
    const firstReason = aggErr.errors?.[0]?.message || aggErr.message;
    throw new Error(firstReason);
  } finally {
    timeouts.forEach(clearTimeout);
  }
}

exports.hlsProxy = onRequest(
  {
    cors: true,
    region: 'asia-northeast3', // 서울 리전 (레이턴시 최소화)
    // 스트리밍은 세그먼트/플레이리스트 요청이 잦아 인스턴스를 빨리 소모하므로,
    // /api(와이파이 검색) 라우터와 인스턴스 풀을 분리해 서로 영향을 주지 않게 한다.
    maxInstances: 30,
    concurrency: 40,
  },
  async (req, res) => {
    // 기대하는 경로 형태: /hlsProxy/ch58_s.stream/playlist.m3u8
    const path = req.path.replace(/^\/hlsProxy\//, '').replace(/^\//, '');
    if (!path) {
      res.status(400).send('missing stream path');
      return;
    }

    let winner;
    try {
      winner = await fetchFromAnyHost(path);
    } catch (err) {
      console.error('hlsProxy failed for path:', path, err);
      res.status(502).send('stream unavailable');
      return;
    }

    res.set('Content-Type', contentTypeFor(path));
    res.set('Cache-Control', cacheControlFor(path));
    res.set('Access-Control-Allow-Origin', '*');

    try {
      // fetch()의 body는 Web ReadableStream이라 Node stream.pipeline에 바로 못 쓰므로
      // Readable.fromWeb으로 변환 후, 버퍼링 없이 upstream body를 그대로 클라이언트로 흘려보낸다.
      await pipeline(Readable.fromWeb(winner.res.body), res);
    } catch (err) {
      // 클라이언트가 연결을 끊는 경우(ERR_STREAM_PREMATURE_CLOSE 등) 정상적인 상황이므로
      // 에러 레벨 로그 없이 조용히 종료한다.
      if (!res.writableEnded) res.end();
    }
  }
);
