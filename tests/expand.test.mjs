// 서울·인천 확대(2026-11-01) 시험: 시군구 이름, 일부 시도 실패 시 새 실행, 시도를 늘린 날 기관 목록·기본정보 다시 받기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCSV } from '../engine/csv.mjs';
import { regionOf } from '../engine/region.mjs';

test('regionOf: 경기는 시군 이름 그대로, 서울·인천은 시도 약칭을 붙여 같은 이름의 구를 구분', () => {
  assert.deepEqual(regionOf('경기도 수원시 팔달구 중부대로 93'), { sido: '경기도', si: '수원시' });
  assert.deepEqual(regionOf('서울특별시 중구 을지로 245'), { sido: '서울특별시', si: '서울 중구' });
  assert.deepEqual(regionOf('인천광역시 중구 인항로 27'), { sido: '인천광역시', si: '인천 중구' });
  assert.notEqual(regionOf('서울특별시 중구 x').si, regionOf('인천광역시 중구 x').si);
  assert.deepEqual(regionOf(''), { sido: '', si: '' });
  assert.deepEqual(regionOf(undefined), { sido: '', si: '' });
});

process.env.SERVICE_KEY = 'test-key';
process.env.RETRY_UNIT_MS = '1';
process.env.STAGES = '서울특별시,경기도,인천광역시';
const wrap = (items) =>
  `<response><header><resultCode>00</resultCode></header><body><items>${items
    .map((o) => '<item>' + Object.entries(o).map(([k, v]) => `<${k}>${v}</${k}>`).join('') + '</item>')
    .join('')}</items><totalCount>${items.length}</totalCount></body></response>`;
const connectTimeout = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
let n = 0;
async function fresh(setup) {
  const dir = mkdtempSync(join(tmpdir(), 'expand-'));
  setup?.(dir);
  process.env.DATA_DIR = dir;
  process.env.REDO = '';
  process.env.REDO_FLAG_FILE = join(dir, 'redo.flag');
  const mod = await import(`../collector/collect.mjs?expand${n++}`);
  return { dir, mod, flag: () => existsSync(join(dir, 'redo.flag')) };
}
// 시도마다 병원 1곳, 주소는 시도 이름으로 시작
const body = (u) => {
  const op = u.pathname.split('/').pop();
  const region = u.searchParams.get('STAGE1') ?? u.searchParams.get('Q0');
  if (op === 'getEgytBassInfoInqire') return wrap([{ hpid: u.searchParams.get('HPID'), dutyName: 'x' }]);
  return wrap([{ hpid: `${region}-1`, dutyName: `${region}병원`, dutyAddr: `${region} 중구 1`, hvec: '3', symTypCod: 'Y000' }]);
};

test('일부 시도만 연결 실패: 받은 시도는 저장하고, 새 실행을 요청한다', async () => {
  const { dir, mod, flag } = await fresh();
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if ((u.searchParams.get('STAGE1') ?? u.searchParams.get('Q0')) === '인천광역시' && u.pathname.endsWith('getEmrrmRltmUsefulSckbdInfoInqire')) throw connectTimeout();
    return new Response(body(u));
  };
  const res = await mod.main();
  assert.deepEqual(res[0], ['beds', false]);
  const beds = parseCSV(readFileSync(join(dir, 'beds', `${today}.csv`), 'utf8'));
  assert.deepEqual(beds.map((r) => r.hpid), ['서울특별시-1', '경기도-1']);
  assert.equal(flag(), true); // 예전에는 모든 시도가 실패해야만 새 실행을 불렀다
  process.exitCode = 0;
});

test('일부 시도가 다시 해도 안 되는 오류(인증키 등)면 새 실행을 요청하지 않는다', async () => {
  const { mod, flag } = await fresh();
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.searchParams.get('STAGE1') === '인천광역시') return new Response('<response><header><resultCode>30</resultCode><resultMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</resultMsg></header></response>');
    return new Response(body(u));
  };
  await mod.main();
  assert.equal(flag(), false);
  process.exitCode = 0;
});

test('시도를 늘린 날: 오늘 받은 기관 목록에 없는 시도가 있으면 다시 받고, 기본정보는 새 기관만 받아 더한다', async () => {
  const at = `${today} 00:00:10`;
  const { dir, mod } = await fresh((d) => {
    writeFileSync(join(d, 'hospitals.csv'), `﻿collected_at,hpid,dutyName,dutyAddr\n${at},경기도-1,경기도병원,경기도 수원시 1\n`);
    writeFileSync(join(d, 'hospital_info.csv'), `﻿collected_at,hpid,dutyName\n${at},경기도-1,옛정보\n`);
  });
  const infoCalls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('getEgytBassInfoInqire')) infoCalls.push(u.searchParams.get('HPID'));
    return new Response(body(u));
  };
  await mod.main();
  const list = parseCSV(readFileSync(join(dir, 'hospitals.csv'), 'utf8'));
  assert.deepEqual(list.map((r) => r.hpid).sort(), ['경기도-1', '서울특별시-1', '인천광역시-1']);
  assert.deepEqual(infoCalls.sort(), ['서울특별시-1', '인천광역시-1']); // 이미 있는 경기 기관은 다시 부르지 않음
  const info = parseCSV(readFileSync(join(dir, 'hospital_info.csv'), 'utf8'));
  assert.deepEqual(info.map((r) => [r.hpid, r.dutyName]), [['서울특별시-1', 'x'], ['경기도-1', '옛정보'], ['인천광역시-1', 'x']]); // 목록 순서
  // 같은 날 한 번 더 돌면 목록·기본정보 모두 다시 부르지 않는다
  infoCalls.length = 0;
  let listCalls = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('getEgytListInfoInqire')) listCalls++;
    if (u.pathname.endsWith('getEgytBassInfoInqire')) infoCalls.push(u.searchParams.get('HPID'));
    return new Response(body(u));
  };
  await mod.main();
  assert.equal(listCalls, 0);
  assert.deepEqual(infoCalls, []);
  process.exitCode = 0;
});

test('여러 시도 중 한 시도만 연결이 한 번 끊기면 1초 뒤 다시 불러 모두 받는다(부분 실패·새 실행 없음)', async () => {
  const { dir, mod, flag } = await fresh();
  let inc = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.searchParams.get('STAGE1') === '인천광역시' && u.pathname.endsWith('getEmrrmRltmUsefulSckbdInfoInqire') && inc++ === 0) throw connectTimeout();
    return new Response(body(u));
  };
  const res = await mod.main();
  assert.deepEqual(res[0], ['beds', true]);
  const beds = parseCSV(readFileSync(join(dir, 'beds', `${today}.csv`), 'utf8'));
  assert.deepEqual(beds.map((r) => r.hpid), ['서울특별시-1', '경기도-1', '인천광역시-1']);
  assert.equal(inc, 2);
  assert.equal(flag(), false);
  process.exitCode = 0;
});
