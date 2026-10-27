// 골든타임 중계 서버 (Cloudflare Workers)
// 카카오 REST API 키를 숨긴 채, 우리 웹앱이 필요한 길찾기 두 가지만 대신 호출한다.
//   GET  /route?origin=경도,위도&destination=경도,위도[&summary=true]   → 자동차 길찾기 (경로 선 포함, summary=true면 시간·거리만)
//   POST /matrix  {"origin":{"x":경도,"y":위도},"destinations":[{"key":"병원ID","x":경도,"y":위도}, ...최대 30]}
//                                                          → 다중 목적지 길찾기 (시간·거리만, 반경 10km)
//   GET  /usage                                            → 오늘(한국 시간) 카카오 길찾기 사용 횟수와 하루 한도
// 보안: 허용한 사이트에서 온 요청만 받는다. 출발지 좌표 같은 요청 내용은 기록하지 않는다.
//       사용량은 '날짜·종류·횟수'만 D1에 센다.
// 설정: Worker의 Settings → Variables and Secrets에 Secret으로 KAKAO_REST_KEY 등록
//       D1 데이터베이스를 만들어 Worker의 Bindings에 이름 DB로 연결 (표는 코드가 스스로 만든다)

const ALLOWED_ORIGINS = ['https://hyun19393.github.io'];
const KAKAO = 'https://apis-navi.kakaomobility.com/v1';
// 카카오 하루 한도 (2026-10 카카오 개발자 문서 기준). multi = 다중 목적지 길찾기, single = 자동차 길찾기
const LIMITS = { multi: 1000, single: 10000 };

// 한국 시간 날짜 (YYYY-MM-DD). 날짜가 바뀌면 새로 센다
const dayKST = (ms = Date.now()) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);

// 사용량 표는 Worker가 처음 쓸 때 만든다. 요청끼리 진행 중인 작업을 나눠 기다리면 Workers에서 취소될 수 있어
// 끝났다는 표시(참/거짓)만 남긴다. 처음 몇 요청이 함께 만들어도 IF NOT EXISTS라 문제없다
let tableReady = false;
async function table(db) {
  if (tableReady) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, kind))').run();
  tableReady = true;
}

// 카카오에 요청을 보낼 때마다 1 더한다 (실패한 요청도 센다). 세기에 실패해도 길찾기는 그대로 한다
async function count(env, kind) {
  if (!env.DB) return;
  try {
    await table(env.DB);
    await env.DB.prepare('INSERT INTO usage (day, kind, n) VALUES (?1, ?2, 1) ON CONFLICT (day, kind) DO UPDATE SET n = n + 1')
      .bind(dayKST(), kind).run();
  } catch { /* 세기 실패: 길찾기는 계속 */ }
}

// 카카오 호출과 세기를 함께 시작해, 응답을 돌려줄 때는 이미 센 상태가 되게 한다
async function kakao(env, kind, url, init) {
  const [r] = await Promise.all([fetch(url, init), count(env, kind)]);
  return r;
}

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
    const url = new URL(request.url);

    if (url.pathname === '/usage' && request.method === 'GET') {
      if (!env.DB) return json({ error: '서버 설정 필요: DB' }, 503, h);
      try {
        await table(env.DB);
        const day = dayKST();
        const { results = [] } = await env.DB.prepare('SELECT kind, n FROM usage WHERE day = ?1').bind(day).all();
        const used = { multi: 0, single: 0 };
        for (const row of results) if (row.kind in used) used[row.kind] = Number(row.n) || 0;
        return json({ day, used, limits: LIMITS }, 200, h);
      } catch {
        return json({ error: '사용량 기록을 읽지 못함' }, 502, h);
      }
    }

    if (!env.KAKAO_REST_KEY) return json({ error: '서버 설정 필요: KAKAO_REST_KEY' }, 500, h);
    const auth = { Authorization: `KakaoAK ${env.KAKAO_REST_KEY}` };

    try {
      if (url.pathname === '/route' && request.method === 'GET') {
        const o = parsePoint(url.searchParams.get('origin'));
        const d = parsePoint(url.searchParams.get('destination'));
        if (!o || !d) return json({ error: '좌표 형식: 경도,위도' }, 400, h);
        const q = new URLSearchParams({ origin: `${o.x},${o.y}`, destination: `${d.x},${d.y}`, priority: 'TIME' });
        if (url.searchParams.get('summary') === 'true') q.set('summary', 'true'); // 시간·거리만 (경로 선 없이 가볍게)
        const r = await kakao(env, 'single', `${KAKAO}/directions?${q}`, { headers: auth });
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
        const r = await kakao(env, 'multi', `${KAKAO}/destinations/directions`, {
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
