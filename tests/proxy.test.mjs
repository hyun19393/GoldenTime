import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../proxy/worker.js';

const ORIGIN = 'https://hyun19393.github.io';
const env = { KAKAO_REST_KEY: 'test-rest-key' };
let last;
globalThis.fetch = async (url, init = {}) => {
  last = { url: String(url), init };
  return new Response(JSON.stringify({ routes: [{ result_code: 0 }] }), { status: 200 });
};
const req = (path, { method = 'GET', origin = ORIGIN, body } = {}) =>
  new Request('https://goldentime-proxy.example.workers.dev' + path, {
    method,
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

test('다른 사이트에서 온 요청은 거절', async () => {
  const r = await worker.fetch(req('/route?origin=127.1,37.3&destination=127.2,37.4', { origin: 'https://evil.example' }), env);
  assert.equal(r.status, 403);
});

test('자동차 길찾기: 키는 서버에서만 붙이고, 응답에 우리 사이트 CORS 허용', async () => {
  const r = await worker.fetch(req('/route?origin=127.1,37.3&destination=127.2,37.4'), env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(last.url, /\/v1\/directions\?origin=127\.1%2C37\.3&destination=127\.2%2C37\.4&priority=TIME$/);
  assert.equal(last.init.headers.Authorization, 'KakaoAK test-rest-key');
  assert.ok(!(await r.text()).includes('test-rest-key')); // 응답에 키가 섞이지 않음
});

test('다중 목적지: 30곳 제한, 형식 검사, 반경 10km', async () => {
  const ds = (n) => Array.from({ length: n }, (_, i) => ({ key: `A${i}`, x: 127 + i / 100, y: 37.3 }));
  assert.equal((await worker.fetch(req('/matrix', { method: 'POST', body: { origin: { x: 127, y: 37 }, destinations: ds(31) } }), env)).status, 400);
  assert.equal((await worker.fetch(req('/matrix', { method: 'POST', body: { origin: { x: 0, y: 0 }, destinations: ds(2) } }), env)).status, 400);
  assert.equal((await worker.fetch(req('/matrix', { method: 'POST', body: { origin: { x: 127, y: 37 }, destinations: [{ key: '<script>', x: 127, y: 37 }] } }), env)).status, 400);
  const r = await worker.fetch(req('/matrix', { method: 'POST', body: { origin: { x: 127.1, y: 37.3 }, destinations: ds(3) } }), env);
  assert.equal(r.status, 200);
  const sent = JSON.parse(last.init.body);
  assert.equal(sent.radius, 10000);
  assert.equal(sent.destinations.length, 3);
});

test('브라우저 사전 확인(OPTIONS)과 없는 주소', async () => {
  assert.equal((await worker.fetch(req('/route', { method: 'OPTIONS' }), env)).status, 204);
  assert.equal((await worker.fetch(req('/other'), env)).status, 404);
  assert.equal((await worker.fetch(req('/route?origin=1,1&destination=2,2'), env)).status, 400);
});

test('키가 설정되지 않았을 때 알려줌', async () => {
  assert.equal((await worker.fetch(req('/route?origin=127.1,37.3&destination=127.2,37.4'), {})).status, 500);
});

test('자동차 길찾기 summary=true: 시간·거리만 요청하고, 다른 값은 그대로 넘기지 않음', async () => {
  await worker.fetch(req('/route?origin=127.1,37.3&destination=127.2,37.4&summary=true'), env);
  assert.match(last.url, /&priority=TIME&summary=true$/);
  await worker.fetch(req('/route?origin=127.1,37.3&destination=127.2,37.4&summary=yes&alternatives=true'), env);
  assert.match(last.url, /&priority=TIME$/); // 'true'가 아니거나 모르는 변수는 카카오로 넘기지 않음
});

// ---------- 오늘 사용량 (D1에 날짜·종류·횟수만 센다)
// 실제 D1처럼 prepare → bind → run/all 을 흉내 내는 가짜 데이터베이스
function fakeD1({ fail = false } = {}) {
  const rows = new Map(); // "day|kind" → n
  const sqls = [];
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async run() {
      sqls.push(sql);
      if (fail) throw new Error('D1 down');
      if (sql.startsWith('INSERT')) { const k = `${args[0]}|${args[1]}`; rows.set(k, (rows.get(k) ?? 0) + 1); }
      return {};
    },
    async all() {
      if (fail) throw new Error('D1 down');
      return { results: [...rows].filter(([k]) => k.startsWith(args[0] + '|')).map(([k, n]) => ({ kind: k.split('|')[1], n })) };
    },
  });
  return { prepare: (sql) => stmt(sql), rows, sqls };
}
const usage = async (e) => (await worker.fetch(req('/usage'), e)).json();

test('사용량: 카카오에 보낸 요청만 종류별로 세고, /usage가 오늘 횟수와 한도를 돌려줌', async () => {
  const DB = fakeD1();
  const e = { ...env, DB };
  await worker.fetch(req('/route?origin=127.1,37.3&destination=127.2,37.4&summary=true'), e);
  await worker.fetch(req('/route?origin=127.1,37.3&destination=127.2,37.4'), e);
  await worker.fetch(req('/matrix', { method: 'POST', body: { origin: { x: 127.1, y: 37.3 }, destinations: [{ key: 'A1', x: 127.2, y: 37.3 }] } }), e);
  // 카카오까지 가지 않은 요청은 세지 않음: 좌표 오류, 사전 확인, 다른 사이트
  await worker.fetch(req('/route?origin=1,1&destination=2,2'), e);
  await worker.fetch(req('/route', { method: 'OPTIONS' }), e);
  await worker.fetch(req('/route?origin=127.1,37.3&destination=127.2,37.4', { origin: 'https://evil.example' }), e);
  const u = await usage(e);
  assert.deepEqual(u.used, { multi: 1, single: 2 });
  assert.deepEqual(u.limits, { multi: 1000, single: 10000 });
  assert.match(u.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!DB.sqls.some((s) => /\d+\.\d+/.test(s))); // 좌표 같은 요청 내용은 저장하지 않음
});

test('사용량: 날짜는 한국 시간 기준이라 한국 0시에 새로 셈', async () => {
  const DB = fakeD1();
  const e = { ...env, DB };
  const realNow = Date.now;
  try {
    Date.now = () => Date.parse('2026-10-28T14:59:00Z'); // 한국 23:59
    await worker.fetch(req('/route?origin=127.1,37.3&destination=127.2,37.4'), e);
    assert.equal((await usage(e)).day, '2026-10-28');
    Date.now = () => Date.parse('2026-10-28T15:00:00Z'); // 한국 다음 날 0:00
    const u = await usage(e);
    assert.equal(u.day, '2026-10-29');
    assert.deepEqual(u.used, { multi: 0, single: 0 });
  } finally { Date.now = realNow; }
});

test('사용량: 실패한 카카오 요청도 셈', async () => {
  const DB = fakeD1();
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ code: -10, msg: 'limit exceeded' }), { status: 429 });
  try {
    const r = await worker.fetch(req('/route?origin=127.1,37.3&destination=127.2,37.4'), { ...env, DB });
    assert.equal(r.status, 429);
    assert.equal((await usage({ ...env, DB })).used.single, 1);
  } finally { globalThis.fetch = real; }
});

test('사용량: DB가 없거나 고장 나도 길찾기는 되고, /usage는 추정하지 않고 오류를 알림', async () => {
  assert.equal((await worker.fetch(req('/route?origin=127.1,37.3&destination=127.2,37.4'), env)).status, 200);
  assert.equal((await worker.fetch(req('/usage'), env)).status, 503);
  const bad = { ...env, DB: fakeD1({ fail: true }) };
  assert.equal((await worker.fetch(req('/route?origin=127.1,37.3&destination=127.2,37.4'), bad)).status, 200);
  assert.equal((await worker.fetch(req('/usage'), bad)).status, 502);
  assert.equal((await worker.fetch(req('/usage', { origin: 'https://evil.example' }), { ...env, DB: fakeD1() })).status, 403);
});

test('사용량: 표 만들기가 한 번 실패해도 다음 요청에서 다시 만들고 셈', async () => {
  const { default: fresh } = await import('../proxy/worker.js?table-retry'); // 표를 아직 안 만든 새 Worker
  const DB = fakeD1();
  let failOnce = true;
  const flaky = { ...DB, prepare: (sql) => {
    if (sql.startsWith('CREATE') && failOnce) { failOnce = false; return { run: async () => { throw new Error('잠깐 실패'); } }; }
    return DB.prepare(sql);
  } };
  const e = { ...env, DB: flaky };
  const route = () => fresh.fetch(req('/route?origin=127.1,37.3&destination=127.2,37.4'), e);
  assert.equal((await route()).status, 200); // 세기는 실패했지만 길찾기는 됨
  assert.equal((await route()).status, 200);
  assert.equal(DB.sqls.filter((s) => s.startsWith('CREATE')).length, 1); // 두 번째 요청에서 다시 만듦
  assert.equal((await (await fresh.fetch(req('/usage'), e)).json()).used.single, 1);
});
