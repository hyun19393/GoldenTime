import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCSV } from '../engine/csv.mjs';

// 실제 응답 원문: 우리 수집기가 처음 저장한 경기도 응답
const SAMPLE = new URL('../data/raw/beds.xml', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'collect-'));
process.env.SERVICE_KEY = 'test-key';
process.env.DATA_DIR = dir;
process.env.RETRY_BASE_MS = '5';
const { parseItems, main, runOp, OPS } = await import('../collector/collect.mjs');

const wrap = (items, total = items.length) =>
  `<?xml version="1.0" encoding="UTF-8"?><response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header><body><items>${items
    .map((o) => '<item>' + Object.entries(o).map(([k, v]) => `<${k}>${v}</${k}>`).join('') + '</item>')
    .join('')}</items><numOfRows>100</numOfRows><pageNo>1</pageNo><totalCount>${total}</totalCount></body></response>`;

// 활용가이드 예시와 같은 모양의 응답
const BEDS = wrap([
  { dutyName: '가병원', hpid: 'A1', hvec: '3', hvs01: '20', hvidate: '20261025100000', hv28: '1', hvs02: '2' },
  { dutyName: '나병원', hpid: 'A2', hvec: '-1', hvs01: '15', hvidate: '20261025100100', hvNEW: 'x' },
]);
const SEVERE = wrap([{ dutyName: '가병원', hpid: 'A1', MKioskTy1: 'Y ', MKioskTy2: '불가능', MKioskTy14: '정보미제공', MKioskTy10Msg: '1day' }]);
const MSGS = wrap([
  { dutyName: '가병원', hpid: 'A1', symBlkMsg: '장비부족', symBlkMsgTyp: '중증', symBlkSttDtm: '20261025090000', symTypCod: 'Y0020', symTypCodMag: '[재관류중재술] 뇌경색', symOutDspYon: '차단' },
  { dutyName: '나병원', hpid: 'A2', symBlkMsg: '응급실 과밀', symBlkMsgTyp: '응급', symBlkSttDtm: '20261025093000', symTypCod: 'Y000', symTypCodMag: '응급실', symOutDspYon: '차단' },
]);
const LIST = wrap([
  { hpid: 'A1', dutyName: '가병원', dutyEmclsName: '지역응급의료센터', wgs84Lat: '37.32', wgs84Lon: '127.10' },
  { hpid: 'A2', dutyName: '나병원', dutyEmclsName: '권역응급의료센터', wgs84Lat: '37.35', wgs84Lon: '127.12' },
]);
const info = (hpid) => wrap([{ hpid, dutyName: hpid === 'A1' ? '가병원' : '나병원', hperyn: '20', dgidIdName: '내과,외과' }]);

const calls = [];
globalThis.fetch = async (url) => {
  const u = new URL(url);
  calls.push(u);
  const op = u.pathname.split('/').pop();
  const body = {
    getEmrrmRltmUsefulSckbdInfoInqire: BEDS,
    getSrsillDissAceptncPosblInfoInqire: SEVERE,
    getEmrrmSrsillDissMsgInqire: MSGS,
    getEgytListInfoInqire: LIST,
    getEgytBassInfoInqire: info(u.searchParams.get('HPID')),
  }[op];
  return new Response(body, { status: 200 });
};

const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const read = (...p) => parseCSV(readFileSync(join(dir, ...p), 'utf8'));

test('응답 XML 해석: 실제 가용병상 응답 예시', { skip: !existsSync(SAMPLE) }, () => {
  const r = parseItems(readFileSync(SAMPLE, 'utf8'));
  assert.equal(r.code, '00');
  assert.equal(r.items.length, r.total); // 경기도 응급실 전부가 한 번에 옴
  assert.ok(r.items.length > 50);
  for (const it of r.items) {
    assert.match(it.hpid, /^[A-Z]\d{7}$/);
    assert.ok(Number.isFinite(Number(it.hvec)), `hvec 숫자 아님: ${it.hvec}`);
    assert.match(it.hvidate, /^\d{14}$/);
  }
});

test('인증 오류 응답 인식', () => {
  const err = parseItems('<OpenAPI_ServiceResponse><cmmMsgHeader><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>');
  assert.equal(err.code, undefined);
  assert.match(err.msg, /NOT_REGISTERED/);
});

test('첫 실행: 5개 기능 모두 저장', async () => {
  const res = await main();
  assert.deepEqual(res, [['beds', true], ['severe', true], ['messages', true]]);

  const beds = read('beds', `${today}.csv`);
  assert.equal(beds.length, 2);
  assert.equal(beds[1].hvec, '-1');
  assert.equal(beds[0].hv28, '1');
  assert.equal(beds[1].hvNEW, 'x'); // 목록에 없던 항목도 버리지 않음

  const sev = read('severe', `${today}.csv`);
  assert.equal(sev[0].MKioskTy1, 'Y'); // 'Y ' 뒤 공백 제거
  assert.equal(sev[0].MKioskTy2, '불가능');

  assert.equal(read('messages', `${today}.csv`).length, 2);
  assert.equal(read('hospitals.csv').length, 2);
  const infoRows = read('hospital_info.csv');
  assert.deepEqual(infoRows.map((r) => r.hpid), ['A1', 'A2']);

  // 요청 변수: 가용병상·중증질환은 STAGE1, 메시지·목록은 Q0, 기본정보는 HPID
  const p = (op) => calls.find((u) => u.pathname.endsWith(op)).searchParams;
  assert.equal(p('getEmrrmRltmUsefulSckbdInfoInqire').get('STAGE1'), '경기도');
  assert.equal(p('getSrsillDissAceptncPosblInfoInqire').get('SM_TYPE'), null); // 질환 지정 없이 28종 전부
  assert.equal(p('getEmrrmSrsillDissMsgInqire').get('Q0'), '경기도');
  assert.equal(p('getEgytListInfoInqire').get('Q0'), '경기도');
  assert.equal(p('getEgytBassInfoInqire').get('HPID'), 'A1');
});

test('두 번째 실행: 10분 기능만 추가, 메시지·하루 1번 기능은 건너뜀', async () => {
  const before = calls.length;
  const res = await main();
  assert.deepEqual(res, [['beds', true], ['severe', true], ['messages', null]]);
  assert.equal(read('beds', `${today}.csv`).length, 4);
  const ops = calls.slice(before).map((u) => u.pathname.split('/').pop());
  assert.deepEqual(ops, ['getEmrrmRltmUsefulSckbdInfoInqire', 'getSrsillDissAceptncPosblInfoInqire']);
});

test('메시지: 이미 저장한 메시지는 다시 쌓지 않음', async () => {
  const msgSpec = { ...OPS.find((o) => o.name === 'messages'), everyMin: 0 };
  await runOp(msgSpec, Date.now());
  assert.equal(read('messages', `${today}.csv`).length, 2);
  process.exitCode = 0;
});

test('공공데이터포털 일시 오류는 다시 시도해서 받아온다', async () => {
  let n = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const op = new URL(url).pathname.split('/').pop();
    if (op === 'getEmrrmRltmUsefulSckbdInfoInqire' && n++ === 0)
      return new Response('<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnAuthMsg>SERVICETIMEOUT_ERROR</returnAuthMsg><returnReasonCode>05</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>');
    return saved(url);
  };
  const ok = await runOp(OPS[0], Date.now());
  globalThis.fetch = saved;
  assert.equal(ok, true);
  assert.equal(n, 2); // 한 번 실패 후 다시 시도
  process.exitCode = 0;
});

test('메시지: 해제되어 사라진 메시지는 해제 기록에 남기고, 지금 목록에서 뺀다', async () => {
  const { trackActive } = await import('../collector/collect.mjs');
  const msgSpec = { ...OPS.find((o) => o.name === 'messages'), everyMin: 0 };
  assert.equal(read('messages_now.csv').length, 2); // 앞선 실행에서 두 건이 걸려 있었음
  const saved = globalThis.fetch;
  // 나병원 메시지가 해제되어 응답에서 빠짐
  globalThis.fetch = async (url) => new URL(url).pathname.endsWith('getEmrrmSrsillDissMsgInqire')
    ? new Response(wrap([parseItems(MSGS).items[0]]), { status: 200 })
    : saved(url);
  await runOp(msgSpec, Date.now());
  globalThis.fetch = saved;
  const nowRows = read('messages_now.csv');
  assert.deepEqual(nowRows.map((r) => r.hpid), ['A1']);
  const gone = read('messages_gone', `${today}.csv`);
  assert.equal(gone.length, 1);
  assert.equal(gone[0].hpid, 'A2');
  assert.match(gone[0].last_seen, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(read('messages', `${today}.csv`).length, 2); // 새로 생긴 것만 쌓는 기록은 그대로
  // 같은 목록을 다시 받으면 해제 기록이 늘지 않는다
  assert.equal(trackActive(msgSpec, parseItems(wrap([parseItems(MSGS).items[0]])).items, '2026-10-25 23:00:00', Date.now()), 0);
  process.exitCode = 0;
});
