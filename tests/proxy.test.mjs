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
