// 골든타임 중계 서버 (Cloudflare Workers)
// 카카오 REST API 키를 숨긴 채, 우리 웹앱이 필요한 길찾기 두 가지만 대신 호출한다.
//   GET  /route?origin=경도,위도&destination=경도,위도   → 자동차 길찾기 (경로 선 포함)
//   POST /matrix  {"origin":{"x":경도,"y":위도},"destinations":[{"key":"병원ID","x":경도,"y":위도}, ...최대 30]}
//                                                          → 다중 목적지 길찾기 (시간·거리만, 반경 10km)
// 보안: 허용한 사이트에서 온 요청만 받는다. 출발지 좌표 같은 요청 내용은 기록하지 않는다.
// 설정: Worker의 Settings → Variables and Secrets에 Secret으로 KAKAO_REST_KEY 등록

const ALLOWED_ORIGINS = ['https://hyun19393.github.io'];
const KAKAO = 'https://apis-navi.kakaomobility.com/v1';

// 대한민국 범위 안의 좌표만 받는다
const inKorea = (x, y) => Number.isFinite(x) && Number.isFinite(y) && x > 124 && x < 132 && y > 33 && y < 39.5;
const parsePoint = (s) => {
  const [x, y] = String(s ?? '').split(',').map(Number);
  return inKorea(x, y) ? { x, y } : null;
};

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '';
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: '허용되지 않은 사이트' }, 403, {});
    const h = cors(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    if (!env.KAKAO_REST_KEY) return json({ error: '서버 설정 필요: KAKAO_REST_KEY' }, 500, h);

    const url = new URL(request.url);
    const auth = { Authorization: `KakaoAK ${env.KAKAO_REST_KEY}` };

    try {
      if (url.pathname === '/route' && request.method === 'GET') {
        const o = parsePoint(url.searchParams.get('origin'));
        const d = parsePoint(url.searchParams.get('destination'));
        if (!o || !d) return json({ error: '좌표 형식: 경도,위도' }, 400, h);
        const q = new URLSearchParams({ origin: `${o.x},${o.y}`, destination: `${d.x},${d.y}`, priority: 'TIME' });
        const r = await fetch(`${KAKAO}/directions?${q}`, { headers: auth });
        return json(await r.json(), r.status, h);
      }

      if (url.pathname === '/matrix' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        const o = body?.origin;
        const ds = Array.isArray(body?.destinations) ? body.destinations : [];
        if (!o || !inKorea(Number(o.x), Number(o.y))) return json({ error: '출발지 좌표 오류' }, 400, h);
        if (ds.length < 1 || ds.length > 30) return json({ error: '목적지는 1~30곳' }, 400, h);
        const destinations = [];
        for (const d of ds) {
          const x = Number(d?.x), y = Number(d?.y);
          if (!inKorea(x, y) || !/^[A-Za-z0-9_-]{1,20}$/.test(String(d?.key ?? ''))) return json({ error: '목적지 형식 오류' }, 400, h);
          destinations.push({ key: String(d.key), x, y });
        }
        const r = await fetch(`${KAKAO}/destinations/directions`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ origin: { x: Number(o.x), y: Number(o.y) }, destinations, radius: 10000, priority: 'TIME' }),
        });
        return json(await r.json(), r.status, h);
      }

      return json({ error: '없는 주소' }, 404, h);
    } catch {
      return json({ error: '길찾기 서버 연결 실패' }, 502, h);
    }
  },
};
