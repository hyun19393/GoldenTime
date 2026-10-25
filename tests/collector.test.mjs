import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCSV } from '../engine/csv.mjs';

const SAMPLE = '/home/claude/tjdalsrb0428-cloud/seoul-er-beds/data/sample_response.xml';
const dir = mkdtempSync(join(tmpdir(), 'collect-'));
process.env.SERVICE_KEY = 'test-key';
process.env.DATA_DIR = dir;
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
  assert.equal(r.items.length, 50);
  assert.equal(r.items[0].hpid, 'A1100043');
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
