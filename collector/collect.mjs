// 응급의료 공공데이터 수집기 (cron-job.org가 10분마다 GitHub Actions를 실행)
// 요청 변수·응답 항목은 「NIA-IFT-OpenAPI활용가이드-01 국립중앙의료원 응급의료정보조회서비스 V13」 기준
//
// 환경 변수
//   SERVICE_KEY  공공데이터포털 인증키 (저장소 Secrets에만 보관, 코드에 쓰지 않음)
//   STAGES       수집할 시도, 쉼표로 구분 (기본: 경기도). 예: 서울특별시,경기도,인천광역시
//   DATA_DIR     저장 폴더 (기본: data)
//   REDO         1이면 '새 실행'(앞 실행이 연결 문제로 실패해서 워크플로가 한 번 더 부른 실행): 끈기 있게 다시 시도한다
//   REDO_FLAG_FILE  가용병상이 연결 문제로 실패해 새 실행이 필요하면 이 파일을 만든다 (워크플로가 읽음)
//
// 실패 대책 (2026-10-26 분석·시뮬레이션 결과, 결재 후 도입)
//   1) 원인 기록: 'fetch failed' 대신 원인 코드(예: UND_ERR_CONNECT_TIMEOUT = 연결 시간 초과)와 시도별 경과를 남긴다
//   2) 빨리 판단: 가용병상이 '서버에 연결조차 못 함'으로 실패하면 같은 서버의 나머지 기능은 이번 실행에서 건너뛴다
//   3) 새 실행 한 번: 실패한 실행 컴퓨터 대신 새 실행 컴퓨터에서 약 1분 뒤 다시 받는다(워크플로의 redo 일)
//   4) 기록 시각 = 가용병상을 실제로 받은 시각 (다시 시도해서 받았을 때 시각이 어긋나지 않게)
//   5) (2026-10-28 점검 후) 정시 실행은 https로 한 번만 부른다. 실패 18번 중 같은 실행 안 재시도로 살아난 것은 0번,
//      새 실행은 11번 모두 성공했다. 재시도로 약 30초를 버리지 않고 바로 새 실행에 맡긴다.
//      http로는 부르지 않는다(인증키가 암호화 없이 주소에 실려 가지 않도록).
//
// 저장 위치                          기능(오퍼레이션)                              주기
//   data/beds/날짜.csv              ① 응급실 실시간 가용병상정보 조회              10분
//   data/severe/날짜.csv            ② 중증질환자 수용가능정보 조회 (질환 28종)     10분
//   data/messages/날짜.csv          ⑨ 응급실 및 중증질환 메시지 조회               1시간 (새 메시지만 추가)
//   data/messages_now.csv           ⑨ 지금 걸려 있는 메시지 목록 (받을 때마다 새로 씀)
//   data/messages_gone/날짜.csv     ⑨ 해제되어 목록에서 사라진 메시지 (last_seen = 마지막으로 보인 시각)
//   data/hospitals.csv              ③ 응급의료기관 목록정보 조회 (좌표·분류)        하루 1번
//   data/hospital_info.csv          ⑤ 응급의료기관 기본정보 조회 (진료과목 등)      하루 1번
//   data/runs.csv                   실행 기록 (성공·실패, 개수, 오류, 원인 코드, 시도 경과, 새 실행 여부)
//   data/raw/<기능>.xml             처음 받은 응답과 오류가 난 응답 원문 (확인용)

import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toCSVLine, parseCSV } from '../engine/csv.mjs';
import { formatKST, kstDate, parseKST } from '../engine/time.mjs';

const KEY = process.env.SERVICE_KEY;
export const STAGES = (process.env.STAGES || process.env.STAGE1 || '경기도').split(',').map((s) => s.trim()).filter(Boolean);
const DATA = process.env.DATA_DIR || 'data';
const BASE = 'apis.data.go.kr/B552657/ErmctInfoInqireService/';
export const REDO = ['1', 'true'].includes(process.env.REDO ?? '');
// 다시 시도하기 전에 기다리는 시간(초). 정시 실행은 다시 시도하지 않고(실패하면 새 실행), 새 실행은 마지막 기회라 끈기 있게 기다린다.
export const WAIT_PLAN = REDO ? [5, 15, 30] : [];
const UNIT_MS = Number(process.env.RETRY_UNIT_MS ?? 1000); // 시험할 때는 1(=1초를 1밀리초로)
// 서버에 연결조차 못 한 오류 (같은 서버의 다른 기능도 실패할 것이 거의 확실)
export const NETWORK = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_SOCKET']);
// 새 실행으로 다시 받아 볼 만한 오류 (인증키 오류처럼 다시 해도 안 되는 것은 뺀다)
export const retryable = (cause) => NETWORK.has(cause) || ['TIMEOUT', 'GATEWAY', 'API_01', 'API_02', 'API_04', 'API_05'].includes(cause) || /^HTTP_5/.test(cause ?? '');
// 오류에서 원인 코드 뽑기: fetch 오류는 cause.code에, 우리가 만든 오류는 kind에 들어 있다
export function causeOf(e) {
  if (e?.kind) return e.kind;
  if (e?.cause?.code) return e.cause.code;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'TIMEOUT';
  return e?.code ?? 'ERROR';
}
// 한 번 실행에 쓸 수 있는 시간. GitHub Actions 제한(8분)에 걸려 수집분까지 잃지 않도록 남은 기능은 다음 실행으로 넘긴다.
const BUDGET_MS = Number(process.env.BUDGET_MS ?? 5.5 * 60e3);
let deadline = Infinity;
const timeUp = () => Date.now() > deadline;
// 공공데이터포털 게이트웨이의 일시적인 오류 (잠시 뒤 다시 부르면 되는 것)
const TRANSIENT = /SERVICE_?TIMEOUT|HTTP_ERROR|APPLICATION_ERROR|DB_ERROR|<returnReasonCode>0?[1245]</;

// ① 가용병상: 분석에 바로 쓰는 항목을 앞에 둔다 (hvec = 응급실 일반병상, hvs01 = 일반 기준병상)
const BED_FIRST = ['hpid', 'dutyName', 'hvidate', 'hvec', 'hvs01', 'hv28', 'hvs02', 'hv29', 'hvs03', 'hv30', 'hvs04'];
// ② 중증질환: mkioskty1~28 (가이드 표기는 소문자, 실제 응답은 MKioskTy)
const SEVERE_FIRST = ['hpid', 'dutyName', ...Array.from({ length: 28 }, (_, i) => `MKioskTy${i + 1}`)];
// ⑨ 메시지: 같은 메시지를 매번 다시 쌓지 않도록 이 항목들이 같으면 같은 메시지로 본다
const MSG_KEY = ['hpid', 'symTypCod', 'symBlkMsgTyp', 'symBlkSttDtm', 'symBlkEndDtm', 'symBlkMsg', 'symOutDspYon'];

export const OPS = [
  { name: 'beds', op: 'getEmrrmRltmUsefulSckbdInfoInqire', params: (r) => ({ STAGE1: r }), first: BED_FIRST, required: true },
  { name: 'severe', op: 'getSrsillDissAceptncPosblInfoInqire', params: (r) => ({ STAGE1: r }), first: SEVERE_FIRST },
  { name: 'messages', op: 'getEmrrmSrsillDissMsgInqire', params: (r) => ({ Q0: r }), everyMin: 55, dedupe: MSG_KEY, maxPages: 30, track: true },
];
const LIST = { name: 'hospitals', op: 'getEgytListInfoInqire', params: (r) => ({ Q0: r }) };
const INFO = { name: 'hospital_info', op: 'getEgytBassInfoInqire' };

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();

export function parseItems(xml) {
  const code = xml.match(/<resultCode>([^<]*)<\/resultCode>/)?.[1];
  const msg = xml.match(/<resultMsg>([^<]*)<\/resultMsg>/)?.[1] ?? xml.match(/<returnAuthMsg>([^<]*)<\/returnAuthMsg>/)?.[1];
  const total = Number(xml.match(/<totalCount>(\d+)<\/totalCount>/)?.[1] ?? NaN);
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const obj = {};
    for (const f of m[1].matchAll(/<(\w+)>([\s\S]*?)<\/\1>/g)) obj[f[1]] = decode(f[2]);
    items.push(obj);
  }
  return { code, msg, total, items };
}

// 한 번 부르기. 실패하면 WAIT_PLAN대로 기다렸다가 다시 시도한다(https만).
// 돌려주는 값: { text, at(성공한 시도를 시작한 시각), trail(실패한 시도 기록) }
async function call(op, params) {
  const trail = [];
  for (let attempt = 0; ; attempt++) {
    const proto = 'https://'; // 인증키가 주소에 들어가므로 암호화된 연결로만 부른다
    const url = new URL(proto + BASE + op);
    url.search = new URLSearchParams({ serviceKey: KEY, ...params }).toString();
    const at = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { kind: `HTTP_${res.status}` });
      if (!text.includes('<resultCode>') && TRANSIENT.test(text)) throw Object.assign(new Error('공공데이터포털 일시 오류'), { kind: 'GATEWAY', xml: text });
      return { text, at, trail };
    } catch (e) {
      trail.push(`${proto.slice(0, -3)}:${causeOf(e)}:${((Date.now() - at) / 1000).toFixed(1)}`);
      if (attempt < WAIT_PLAN.length && !timeUp()) {
        await new Promise((r) => setTimeout(r, WAIT_PLAN[attempt] * UNIT_MS));
        continue;
      }
      e.trail = trail;
      throw e;
    }
  }
}

const ROWS = 100;
async function fetchAll(spec, extraParams = {}) {
  const items = [];
  let total = 0;
  let firstXml = '';
  let at;
  const trail = [];
  const maxPages = spec.maxPages ?? 10;
  for (let page = 1; page <= maxPages; page++) {
    if (page > 1 && timeUp()) throw Object.assign(new Error('시간 부족으로 중단'), { kind: 'BUDGET', trail });
    const got = await call(spec.op, { ...spec.params, ...extraParams, pageNo: page, numOfRows: ROWS }).catch((e) => {
      e.trail = [...trail, ...(e.trail ?? [])];
      throw e;
    });
    trail.push(...got.trail);
    const xml = got.text;
    if (page === 1) { firstXml = xml; at = got.at; }
    const r = parseItems(xml);
    if (r.code !== '00') {
      // 인증키 오류(30 등)는 resultCode 없이 returnReasonCode로 온다
      const code = r.code ?? xml.match(/<returnReasonCode>([^<]*)<\/returnReasonCode>/)?.[1] ?? '?';
      throw Object.assign(new Error(`resultCode=${code} ${r.msg ?? ''}`.trim()), { kind: `API_${code}`, xml, trail });
    }
    total = Number.isFinite(r.total) ? r.total : r.items.length;
    if (total > 0 && r.items.length === 0) throw Object.assign(new Error(`응답 잘림: totalCount=${total}인데 항목 없음`), { kind: 'TRUNCATED', xml, trail });
    items.push(...r.items);
    if (items.length >= total || r.items.length < ROWS) break;
  }
  return { items, total, firstXml, at, trail };
}

// 여러 시도를 차례로 불러 합친다. 실패한 시도는 failed에 모으고 나머지는 그대로 쓴다.
async function fetchRegions(spec) {
  const items = [];
  const failed = [];
  const causes = [];
  const trail = [];
  let total = 0;
  let firstXml = '';
  let errXml;
  let at;
  for (const region of STAGES) {
    try {
      const r = await fetchAll({ ...spec, params: spec.params(region) });
      items.push(...r.items);
      total += r.total;
      firstXml ||= r.firstXml;
      at ??= r.at;
      trail.push(...r.trail);
    } catch (e) {
      const cause = causeOf(e);
      failed.push(`${region}: ${e.message}${e.message === 'fetch failed' ? ` (${cause})` : ''}`);
      causes.push(cause);
      trail.push(...(e.trail ?? []));
      errXml ??= e.xml;
    }
  }
  return { items, total, firstXml, failed, causes, trail, errXml, at };
}

function ensureDir(p) {
  mkdirSync(dirname(p), { recursive: true });
}

function readHeader(file) {
  return readFileSync(file, 'utf8').split('\n', 1)[0].replace(/^﻿/, '').split(',');
}

// 날짜별 CSV에 이어 쓰기. 파일을 처음 만들 때 머리글을 정하고, 머리글에 없는 항목은 _extra에 JSON으로 남긴다.
function appendRows(file, first, rows, collectedAt) {
  ensureDir(file);
  let header;
  if (existsSync(file)) header = readHeader(file);
  else {
    const seen = [...(first ?? [])];
    for (const r of rows) for (const k of Object.keys(r)) if (!seen.includes(k)) seen.push(k);
    header = ['collected_at', ...seen, '_extra'];
    writeFileSync(file, '﻿' + toCSVLine(header) + '\n');
  }
  const lines = rows.map((r) => {
    const extra = {};
    for (const [k, v] of Object.entries(r)) if (!header.includes(k)) extra[k] = v;
    return toCSVLine(
      header.map((h) => (h === 'collected_at' ? collectedAt : h === '_extra' ? (Object.keys(extra).length ? JSON.stringify(extra) : '') : r[h] ?? '')),
    );
  });
  if (lines.length) appendFileSync(file, lines.join('\n') + '\n');
}

// 하루 한 번 받는 표는 덮어쓴다
function writeTable(file, rows, collectedAt) {
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const header = ['collected_at', ...cols];
  const body = rows.map((r) => toCSVLine(header.map((h) => (h === 'collected_at' ? collectedAt : r[h] ?? ''))));
  ensureDir(file);
  writeFileSync(file, '﻿' + [toCSVLine(header), ...body].join('\n') + '\n');
}

// cause = 원인 코드, attempts = 실패한 시도 기록(프로토콜:원인:초 | …), run = 'redo'이면 새 실행
export const RUN_COLS = ['started_at', 'op', 'ok', 'total', 'items', 'ms', 'error', 'cause', 'attempts', 'run'];
function logRun(entry) {
  const file = join(DATA, 'runs.csv');
  ensureDir(file);
  if (!existsSync(file)) writeFileSync(file, '\ufeff' + toCSVLine(RUN_COLS) + '\n');
  else if (readHeader(file).length < RUN_COLS.length) {
    // 예전 머리글(원인 칸 없음)이면 머리글 줄만 새로 쓴다. 예전 줄의 새 칸은 빈칸으로 읽힌다.
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, '\ufeff' + toCSVLine(RUN_COLS) + text.slice(text.indexOf('\n')));
  }
  appendFileSync(file, toCSVLine(RUN_COLS.map((c) => entry[c] ?? (c === 'run' && REDO ? 'redo' : ''))) + '\n');
}

// 가용병상이 바로 앞 실행들에서 연달아 실패한 횟수 (긴 장애 중이면 새 실행을 부르지 않는다)
function recentBedFailures() {
  const file = join(DATA, 'runs.csv');
  if (!existsSync(file)) return 0;
  const rows = parseCSV(readFileSync(file, 'utf8')).filter((r) => r.op === 'beds');
  let n = 0;
  for (let i = rows.length - 1; i >= 0 && rows[i].ok !== '1'; i--) n++;
  return n;
}

// 이 기능이 마지막으로 성공한 시각 (주기가 긴 기능용)
function lastSuccess(op) {
  const file = join(DATA, 'runs.csv');
  if (!existsSync(file)) return -Infinity;
  const rows = parseCSV(readFileSync(file, 'utf8'));
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].op === op && rows[i].ok === '1') return parseKST(rows[i].started_at);
  return -Infinity;
}

function saveRaw(name, xml, force = false) {
  const file = join(DATA, 'raw', `${name}.xml`);
  if (!xml || (!force && existsSync(file))) return;
  ensureDir(file);
  writeFileSync(file, xml);
}

// ctx: 한 번의 실행 안에서 기능끼리 나누는 정보
//   label    기록 시각(가용병상을 실제로 받은 시각). 중증질환도 이 시각으로 저장해야 가용병상과 짝이 맞는다.
//   hostDown 가용병상이 서버에 연결조차 못 했으면 true → 같은 서버의 나머지 기능은 건너뛴다
//   redo     새 실행으로 다시 받아 볼 만한 실패면 true
export async function runOp(spec, now, ctx = {}) {
  if (spec.everyMin && now - lastSuccess(spec.name) < spec.everyMin * 60e3) return null; // 아직 주기가 안 됨
  if (!spec.required && timeUp()) return null; // 시간이 모자라면 다음 실행에서
  if (ctx.hostDown) {
    logRun({ started_at: formatKST(now), op: spec.name, ok: 0, ms: 0, error: '건너뜀: 같은 서버에 연결하지 못함', cause: 'SKIPPED' });
    console.error(`${spec.name} 건너뜀: 같은 서버에 연결하지 못함`);
    return false;
  }
  const t0 = Date.now();
  const { items, total, firstXml, failed, causes, trail, errXml, at } = await fetchRegions(spec);
  const collectedAt = formatKST(ctx.label ?? at ?? now);
  const attempts = trail.join('|');
  if (failed.length) saveRaw(`${spec.name}-error`, errXml, true);
  if (failed.length === STAGES.length) {
    logRun({ started_at: formatKST(now), op: spec.name, ok: 0, ms: Date.now() - t0, error: failed.join(' / ').slice(0, 200), cause: causes.join(','), attempts });
    console.error(`${spec.name} 실패: ${failed.join(' / ')} · 시도: ${attempts}`);
    if (spec.required) {
      if (causes.every((c) => NETWORK.has(c))) ctx.hostDown = true;
      if (causes.every(retryable)) ctx.redo = true;
    }
    return false;
  }
  if (spec.required) ctx.label ??= at;
  saveRaw(spec.name, firstXml); // 처음 한 번만 원문 저장
  const file = join(DATA, spec.name, `${kstDate(now)}.csv`);
  let rows = items;
  if (spec.dedupe) {
    const key = (r) => spec.dedupe.map((k) => r[k] ?? '').join('|');
    const seen = new Set(existsSync(file) ? parseCSV(readFileSync(file, 'utf8')).map(key) : []);
    // 파일에 이미 있는 것과, 같은 응답 안에서 두 번 온 것을 모두 거른다
    rows = items.filter((r) => { const k = key(r); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  appendRows(file, spec.first, rows, collectedAt);
  if (spec.track && !failed.length) trackActive(spec, items, collectedAt, now); // 일부만 받았을 때는 '사라짐'을 판단하지 않는다
  const ok = failed.length ? 0 : 1; // 일부 시도만 실패하면 받은 것은 저장하고 실패로 기록
  logRun({ started_at: collectedAt, op: spec.name, ok, total, items: rows.length, ms: Date.now() - t0, error: failed.join(' / ').slice(0, 200), cause: causes.join(','), attempts });
  console.log(`${spec.name}: ${rows.length}/${total}${failed.length ? ` (실패: ${failed.join(' / ')})` : ''}${trail.length ? ` · 다시 시도해서 받음: ${attempts}` : ''}`);
  return ok === 1;
}

// 메시지는 새로 생긴 것만 쌓기 때문에, 병원이 해제한 메시지를 따로 알 수 없었다.
// 그래서 받을 때마다 지금 걸려 있는 목록(<이름>_now.csv)을 새로 쓰고,
// 지난번 목록에는 있었는데 이번에 사라진 메시지는 해제 기록(<이름>_gone/날짜.csv)에 남긴다.
export function trackActive(spec, items, collectedAt, now) {
  const key = (r) => spec.dedupe.map((k) => r[k] ?? '').join('|');
  const nowFile = join(DATA, `${spec.name}_now.csv`);
  const prev = existsSync(nowFile) ? parseCSV(readFileSync(nowFile, 'utf8')) : [];
  const cur = new Set(items.map(key));
  const gone = prev.filter((r) => !cur.has(key(r))).map(({ collected_at, ...r }) => ({ last_seen: collected_at, ...r }));
  if (gone.length) appendRows(join(DATA, `${spec.name}_gone`, `${kstDate(now)}.csv`), ['last_seen', ...spec.dedupe], gone, collectedAt);
  writeTable(nowFile, items, collectedAt);
  return gone.length;
}

function doneToday(file, today) {
  if (!existsSync(file)) return false;
  const rows = parseCSV(readFileSync(file, 'utf8'));
  return rows.length > 0 && rows[0].collected_at?.startsWith(today);
}

// 하루 한 번: 기관 목록(좌표) → 기관별 기본정보
async function refreshDaily(now) {
  const today = kstDate(now);
  const listFile = join(DATA, 'hospitals.csv');
  if (!doneToday(listFile, today)) {
    const { items, total, firstXml, failed } = await fetchRegions(LIST);
    if (!items.length) {
      logRun({ started_at: formatKST(now), op: LIST.name, ok: 0, error: failed.join(' / ').slice(0, 200) });
      return;
    }
    saveRaw(LIST.name, firstXml);
    writeTable(listFile, items, formatKST(now));
    logRun({ started_at: formatKST(now), op: LIST.name, ok: failed.length ? 0 : 1, total, items: items.length, error: failed.join(' / ').slice(0, 200) });
  }
  const infoFile = join(DATA, 'hospital_info.csv');
  if (doneToday(infoFile, today) || !existsSync(listFile)) return;
  const hpids = parseCSV(readFileSync(listFile, 'utf8')).map((r) => r.hpid).filter(Boolean);
  const rows = [];
  let failed = 0;
  let skipped = 0;
  let next = 0;
  // 기관마다 한 번씩 불러야 해서 4곳씩 동시에 부른다
  const worker = async () => {
    while (next < hpids.length) {
      const HPID = hpids[next++];
      if (timeUp()) { skipped++; continue; }
      try {
        const { items, firstXml } = await fetchAll({ ...INFO, params: {} }, { HPID });
        saveRaw(INFO.name, firstXml);
        rows.push(...items);
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const order = new Map(hpids.map((h, i) => [h, i]));
  rows.sort((a, b) => (order.get(a.hpid) ?? 1e9) - (order.get(b.hpid) ?? 1e9));
  if (rows.length) writeTable(infoFile, rows, formatKST(now));
  const err = [failed && `${failed}곳 실패`, skipped && `${skipped}곳 시간 부족`].filter(Boolean).join(', ');
  logRun({ started_at: formatKST(now), op: INFO.name, ok: err ? 0 : 1, total: hpids.length, items: rows.length, error: err });
}

export async function main() {
  if (!KEY) {
    console.error('SERVICE_KEY가 없습니다. 저장소 Settings > Secrets에 등록하세요.');
    process.exit(1);
  }
  const now = Date.now();
  deadline = now + BUDGET_MS;
  const ctx = {};
  const before = recentBedFailures(); // 이번 실행 전까지 가용병상이 연달아 실패한 횟수
  const results = [];
  for (const spec of OPS) results.push([spec, await runOp(spec, now, ctx)]);
  if (!ctx.hostDown) await refreshDaily(now); // 서버에 연결이 안 되면 하루 1번 기능도 다음 실행에서
  const bedsFailed = results.some(([spec, ok]) => spec.required && ok === false);
  // 꼭 필요한 기능(가용병상)이 실패하면 실행을 실패로 표시해 알림을 받는다
  if (bedsFailed) process.exitCode = 1;
  // 새 실행 요청: 다시 해 볼 만한 실패이고, 이번 실행이 새 실행이 아니며, 긴 장애 중(앞에서 2번 이상 연달아 실패)이 아닐 때만
  const wantRedo = Boolean(bedsFailed && ctx.redo && !REDO && before < 2);
  if (wantRedo && process.env.REDO_FLAG_FILE) writeFileSync(process.env.REDO_FLAG_FILE, '1\n');
  if (bedsFailed) console.error(wantRedo ? '→ 새 실행 컴퓨터에서 한 번 더 받도록 요청합니다' : '→ 새 실행은 요청하지 않습니다' + (REDO ? ' (이미 새 실행)' : before >= 2 ? ' (긴 장애 중)' : ' (새 실행 대상이 아닌 실패)'));
  return results.map(([spec, ok]) => [spec.name, ok]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
