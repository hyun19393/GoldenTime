import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineM, planPairs, buildMatrix } from '../scripts/travel-matrix.mjs';

const pt = (id, lat, lon) => ({ id, name: id, lat, lon });

test('직선거리 계산 (위도 0.1도 ≈ 11.1km)', () => {
  const d = haversineM({ lat: 37.0, lon: 127.0 }, { lat: 37.1, lon: 127.0 });
  assert.ok(Math.abs(d - 11119) < 20, String(d));
});

test('짝 정하기: 10km 안은 다중 목적지, 밖은 가까운 5곳', () => {
  const ers = [pt('A', 37.0, 127.0), pt('B', 37.05, 127.0), ...Array.from({ length: 7 }, (_, i) => pt(`F${i}`, 37.2 + i * 0.05, 127.0))];
  const a = planPairs(ers).find((p) => p.from.id === 'A');
  assert.deepEqual(a.near.map((b) => b.id), ['B']);
  assert.deepEqual(a.far.map((b) => b.id), ['F0', 'F1', 'F2', 'F3', 'F4']);
});

test('길찾기 결과를 표로 모음 (실패·시간 부족 집계)', async () => {
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/destinations/')) {
      const body = JSON.parse(init.body);
      assert.equal(init.headers.Authorization.startsWith('KakaoAK '), true);
      return new Response(JSON.stringify({ routes: body.destinations.map((d) => ({ key: d.key, result_code: 0, summary: { duration: 600, distance: 5000 } })) }));
    }
    return new Response(JSON.stringify({ routes: [{ result_code: 104, result_msg: '출발지와 도착지가 5m 이내' }] }));
  };
  const plan = planPairs([pt('A', 37.0, 127.0), pt('B', 37.05, 127.0), pt('C', 37.3, 127.0)]);
  const res = await buildMatrix(plan);
  assert.ok(res.rows.some((r) => r[0] === 'A' && r[1] === 'B' && r[2] === 600 && r[4] === 'multi'));
  assert.ok(res.failed > 0); // 먼 곳 단일 길찾기는 실패 코드로 응답
  const late = await buildMatrix(plan, { deadline: 0 });
  assert.equal(late.rows.length, 0);
  assert.equal(late.skipped, late.calls);
});
