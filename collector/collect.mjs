// 응급의료 공공데이터 수집기 (cron-job.org가 10분마다 GitHub Actions를 실행)
// 요청 변수·응답 항목은 「NIA-IFT-OpenAPI활용가이드-01 국립중앙의료원 응급의료정보조회서비스 V13」 기준
//
// 환경 변수
//   SERVICE_KEY  공공데이터포털 인증키 (저장소 Secrets에만 보관, 코드에 쓰지 않음)
//   STAGES       수집할 시도, 쉼표로 구분 (기본: 경기도). 예: 서울특별시,경기도,인천광역시
//   DATA_DIR     저장 폴더 (기본: data)
//
// 저장 위치                          기능(오퍼레이션)                              주기
//   data/beds/날짜.csv              ① 응급실 실시간 가용병상정보 조회              10분
//   data/severe/날짜.csv            ② 중증질환자 수용가능정보 조회 (질환 28종)     10분
//   data/messages/날짜.csv          ⑨ 응급실 및 중증질환 메시지 조회               1시간 (새 메시지만 추가)
//   data/messages_now.csv           ⑨ 지금 걸려 있는 메시지 목록 (받을 때마다 새로 씀)
//   data/messages_gone/날짜.csv     ⑨ 해제되어 목록에서 사라진 메시지 (last_seen = 마지막으로 보인 시각)
//   data/hospitals.csv              ③ 응급의료기관 목록정보 조회 (좌표·분류)        하루 1번
//   data/hospital_info.csv          ⑤ 응급의료기관 기본정보 조회 (진료과목 등)      하루 1번
//   data/runs.csv                   실행 기록 (성공·실패, 개수, 오류)
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
const RETRY_MS = Number(process.env.RETRY_BASE_MS ?? 3000);
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

async function call(op, params, attempt = 0) {
  const proto = attempt % 2 === 0 ? 'https://' : 'http://'; // 연결이 가끔 끊겨서 번갈아 시도
  const url = new URL(proto + BASE + op);
  url.search = new URLSearchParams({ serviceKey: KEY, ...params }).toString();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!text.includes('<resultCode>') && TRANSIENT.test(text)) {
      const err = new Error('공공데이터포털 일시 오류');
      err.xml = text;
      throw err;
    }
    return text;
  } catch (e) {
    if (attempt < 2 && !timeUp()) {
      await new Promise((r) => setTimeout(r, RETRY_MS * (attempt + 1)));
      return call(op, params, attempt + 1);
    }
    throw e;
  }
}

const ROWS = 100;
async function fetchAll(spec, extraParams = {}) {
  const items = [];
  let total = 0;
  let firstXml = '';
  const maxPages = spec.maxPages ?? 10;
  for (let page = 1; page <= maxPages; page++) {
    if (page > 1 && timeUp()) throw new Error('시간 부족으로 중단');
    const xml = await call(spec.op, { ...spec.params, ...extraParams, pageNo: page, numOfRows: ROWS });
    if (page === 1) firstXml = xml;
    const r = parseItems(xml);
    if (r.code !== '00') {
      const err = new Error(`resultCode=${r.code ?? '?'} ${r.msg ?? ''}`.trim());
      err.xml = xml;
      throw err;
    }
    total = Number.isFinite(r.total) ? r.total : r.items.length;
    if (total > 0 && r.items.length === 0) {
      const err = new Error(`응답 잘림: totalCount=${total}인데 항목 없음`);
      err.xml = xml;
      throw err;
    }
    items.push(...r.items);
    if (items.length >= total || r.items.length < ROWS) break;
  }
  return { items, total, firstXml };
}

// 여러 시도를 차례로 불러 합친다. 실패한 시도는 failed에 모으고 나머지는 그대로 쓴다.
async function fetchRegions(spec) {
  const items = [];
  const failed = [];
  let total = 0;
  let firstXml = '';
  let errXml;
  for (const region of STAGES) {
    try {
      const r = await fetchAll({ ...spec, params: spec.params(region) });
      items.push(...r.items);
      total += r.total;
      firstXml ||= r.firstXml;
    } catch (e) {
      failed.push(`${region}: ${e.message}`);
      errXml ??= e.xml;
    }
  }
  return { items, total, firstXml, failed, errXml };
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

const RUN_COLS = ['started_at', 'op', 'ok', 'total', 'items', 'ms', 'error'];
function logRun(entry) {
  const file = join(DATA, 'runs.csv');
  ensureDir(file);
  if (!existsSync(file)) writeFileSync(file, '﻿' + toCSVLine(RUN_COLS) + '\n');
  appendFileSync(file, toCSVLine(RUN_COLS.map((c) => entry[c] ?? '')) + '\n');
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

export async function runOp(spec, now) {
  if (spec.everyMin && now - lastSuccess(spec.name) < spec.everyMin * 60e3) return null; // 아직 주기가 안 됨
  if (!spec.required && timeUp()) return null; // 시간이 모자라면 다음 실행에서
  const t0 = Date.now();
  const collectedAt = formatKST(now);
  const { items, total, firstXml, failed, errXml } = await fetchRegions(spec);
  if (failed.length) saveRaw(`${spec.name}-error`, errXml, true);
  if (failed.length === STAGES.length) {
    logRun({ started_at: collectedAt, op: spec.name, ok: 0, ms: Date.now() - t0, error: failed.join(' / ').slice(0, 200) });
    console.error(`${spec.name} 실패: ${failed.join(' / ')}`);
    return false;
  }
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
  logRun({ started_at: collectedAt, op: spec.name, ok, total, items: rows.length, ms: Date.now() - t0, error: failed.join(' / ').slice(0, 200) });
  console.log(`${spec.name}: ${rows.length}/${total}${failed.length ? ` (실패: ${failed.join(' / ')})` : ''}`);
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
  const results = [];
  for (const spec of OPS) results.push([spec, await runOp(spec, now)]);
  await refreshDaily(now);
  // 꼭 필요한 기능(가용병상)이 실패하면 실행을 실패로 표시해 알림을 받는다
  if (results.some(([spec, ok]) => spec.required && ok === false)) process.exitCode = 1;
  return results.map(([spec, ok]) => [spec.name, ok]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
