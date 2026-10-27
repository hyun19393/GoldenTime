// 수집 실패 대책 시험: 실제 수집 코드(collector/collect.mjs)에 가짜 fetch를 넣어,
// 10/25~26에 실제로 일어난 실패(연결 시간 초과 약 10초 × 3번)와 다른 실패들을 재현한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCSV } from '../engine/csv.mjs';

process.env.SERVICE_KEY = 'test-key';
process.env.RETRY_UNIT_MS = '1';
const realNow = Date.now.bind(Date);
let offset = 0; // 가짜 시계: 연결 시간 초과 한 번마다 10초가 흐른 것으로 친다
Date.now = () => realNow() + offset;

const wrap = (items) =>
  `<response><header><resultCode>00</resultCode></header><body><items>${items
    .map((o) => '<item>' + Object.entries(o).map(([k, v]) => `<${k}>${v}</${k}>`).join('') + '</item>')
    .join('')}</items><totalCount>${items.length}</totalCount></body></response>`;
const OK_BODY = (op, u) => (op === 'getEgytBassInfoInqire'
  ? wrap([{ hpid: u.searchParams.get('HPID') }])
  : wrap([{ hpid: 'A1', dutyName: '가병원', hvec: '2', hvidate: '20261026100000', MKioskTy1: 'Y', symTypCod: 'Y000', symBlkMsg: 'x', symBlkSttDtm: '20261026090000' }]));
const connectTimeout = () => { offset += 10_000; return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }); };

// 시나리오마다 새 저장 폴더와 새 모듈(환경 변수를 다시 읽도록)
let n = 0;
async function fresh({ redo = false, runsCsv } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stab-'));
  if (runsCsv) writeFileSync(join(dir, 'runs.csv'), runsCsv);
  process.env.DATA_DIR = dir;
  process.env.REDO = redo ? '1' : '';
  process.env.REDO_FLAG_FILE = join(dir, 'redo.flag');
  const mod = await import(`../collector/collect.mjs?stab${n++}`);
  return { dir, mod, runs: () => parseCSV(readFileSync(join(dir, 'runs.csv'), 'utf8')), flag: () => existsSync(join(dir, 'redo.flag')) };
}
const opOf = (url) => new URL(url).pathname.split('/').pop();

test('연결 시간 초과(실제 실패 재현): https로 한 번만 시도하고, 같은 서버 기능은 건너뛰고, 원인을 남기고, 새 실행을 요청', async () => {
  const { mod, runs, flag } = await fresh();
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(new URL(url)); throw connectTimeout(); };
  const res = await mod.main();
  assert.deepEqual(res, [['beds', false], ['severe', false], ['messages', false]]);
  // 가용병상만 https로 1번 시도(같은 실행 안 재시도는 살아난 적이 없어 바로 새 실행에 맡김), 나머지 기능과 하루 1번 기능은 부르지 않음
  assert.deepEqual(calls.map((u) => [opOf(u), u.protocol]), [['getEmrrmRltmUsefulSckbdInfoInqire', 'https:']]);
  const r = runs();
  const beds = r.find((x) => x.op === 'beds');
  assert.equal(beds.ok, '0');
  assert.equal(beds.cause, 'UND_ERR_CONNECT_TIMEOUT');
  assert.equal(beds.attempts, 'https:UND_ERR_CONNECT_TIMEOUT:10.0');
  assert.equal(Number(beds.ms) < 15000, true); // 예전에는 약 40초
  assert.match(beds.error, /fetch failed \(UND_ERR_CONNECT_TIMEOUT\)/);
  assert.deepEqual(r.filter((x) => x.op !== 'beds').map((x) => [x.op, x.cause]), [['severe', 'SKIPPED'], ['messages', 'SKIPPED']]);
  assert.equal(flag(), true);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
});

test('긴 장애 중(앞에서 2번 연달아 실패)이면 새 실행을 요청하지 않는다', async () => {
  const head = '﻿started_at,op,ok,total,items,ms,error\n';
  const old = '2026-10-26 10:00:20,beds,0,,,40500,경기도: fetch failed\n2026-10-26 10:10:20,beds,0,,,40500,경기도: fetch failed\n';
  const { mod, flag } = await fresh({ runsCsv: head + old });
  globalThis.fetch = async () => { throw connectTimeout(); };
  await mod.main();
  assert.equal(flag(), false);
  process.exitCode = 0;
});

test('예전 머리글의 runs.csv는 머리글만 새로 쓰고 예전 줄은 그대로 읽힌다', async () => {
  const head = '﻿started_at,op,ok,total,items,ms,error\n';
  const old = '2026-10-26 10:00:20,beds,1,73,73,1400,\n';
  const { mod, runs, dir } = await fresh({ runsCsv: head + old });
  globalThis.fetch = async (url) => new Response(OK_BODY(opOf(url), new URL(url)));
  await mod.main();
  const text = readFileSync(join(dir, 'runs.csv'), 'utf8');
  assert.equal(text.split('\n')[0], '﻿' + mod.RUN_COLS.join(','));
  const r = runs();
  assert.equal(r[0].started_at, '2026-10-26 10:00:20');
  assert.equal(r[0].cause, '');
  assert.equal(r.at(-1).op === 'hospital_info' || r.at(-1).op === 'hospitals' || r.at(-1).op === 'messages', true);
  process.exitCode = 0;
});

test('새 실행에서 세 번째 시도에 받으면: 기록 시각 = 실제로 받은 시각, 중증질환도 같은 시각으로 저장', async () => {
  const { mod, runs, dir } = await fresh({ redo: true });
  let bedTries = 0;
  const start = Date.now();
  globalThis.fetch = async (url) => {
    const op = opOf(url);
    if (op === 'getEmrrmRltmUsefulSckbdInfoInqire' && bedTries++ < 2) throw connectTimeout();
    return new Response(OK_BODY(op, new URL(url)));
  };
  const res = await mod.main();
  assert.deepEqual(res.slice(0, 2), [['beds', true], ['severe', true]]);
  const today = (await import('../engine/time.mjs')).kstDate(start);
  const beds = parseCSV(readFileSync(join(dir, 'beds', `${today}.csv`), 'utf8'));
  const sev = parseCSV(readFileSync(join(dir, 'severe', `${today}.csv`), 'utf8'));
  const { parseKST } = await import('../engine/time.mjs');
  // 실패 2번 동안 가짜 시계가 20초 흘렀으므로 기록 시각은 시작보다 약 20초 뒤
  const lag = (parseKST(beds[0].collected_at) - start) / 1000;
  assert.ok(lag >= 19 && lag <= 21, `기록 시각 차이 ${lag}초`);
  assert.equal(sev[0].collected_at, beds[0].collected_at); // 짝이 맞음
  const b = runs().find((x) => x.op === 'beds');
  assert.equal(b.ok, '1');
  assert.equal(b.attempts.split('|').length, 2); // 실패한 시도 2번이 남음
  process.exitCode = 0;
});

test('인증키 오류처럼 다시 해도 안 되는 실패: 건너뛰지 않고 새 실행도 요청하지 않는다', async () => {
  const { mod, runs, flag } = await fresh();
  globalThis.fetch = async (url) => (opOf(url) === 'getEmrrmRltmUsefulSckbdInfoInqire'
    ? new Response('<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>')
    : new Response(OK_BODY(opOf(url), new URL(url))));
  const res = await mod.main();
  assert.deepEqual(res.slice(0, 2), [['beds', false], ['severe', true]]);
  assert.equal(runs().find((x) => x.op === 'beds').cause, 'API_30');
  assert.equal(flag(), false);
  process.exitCode = 0;
});

test('새 실행(REDO=1): 4번까지 끈기 있게 시도하고, 기록에 redo 표시, 다시 새 실행을 부르지 않음', async () => {
  const { mod, runs, flag } = await fresh({ redo: true });
  assert.deepEqual(mod.WAIT_PLAN, [5, 15, 30]);
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(new URL(url)); throw connectTimeout(); };
  await mod.main();
  assert.equal(calls.length, 4);
  assert.ok(calls.every((u) => u.protocol === 'https:')); // http로는 부르지 않음
  const b = runs().find((x) => x.op === 'beds');
  assert.equal(b.run, 'redo');
  assert.equal(flag(), false);
  process.exitCode = 0;
});

test('원인 코드 뽑기', async () => {
  const { mod } = await fresh();
  assert.equal(mod.causeOf(connectTimeout()), 'UND_ERR_CONNECT_TIMEOUT');
  assert.equal(mod.causeOf(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'TIMEOUT');
  assert.equal(mod.causeOf(Object.assign(new Error('HTTP 503'), { kind: 'HTTP_503' })), 'HTTP_503');
  assert.equal(mod.retryable('HTTP_503'), true);
  assert.equal(mod.retryable('API_30'), false);
  assert.equal(mod.retryable('UND_ERR_CONNECT_TIMEOUT'), true);
});
