// 질환별 거절 확률 (11/1 무렵 웹앱에 공개 예정, 지금은 통계표만 쌓는다)
//
// 질환 d가 의심되는 환자의 '도착 시 거절' = 응급실 병상 0 이하 또는 그 질환 '불가능' 표시
// 지금 상태 구간: 그 질환이 지금 '불가능'이면 'dN', 아니면 병상 구간(0 이하, 1개, …)
// 그 질환 표시가 '정보미제공'인 기록은 쓰지 않는다. 그런 병원은 후보에서 빼고 '확인 필요'로 표시한다.
// '불가능' 기록이 드물어서, 칸의 기록이 적으면 모든 질환을 합친 통계 쪽으로 당긴다.
//   단계: 모든 질환 합계 → 이 질환 전체 → 이 질환 같은 시간대 → 이 병원
import { buildModel, bedBucket, hourBin, shrink, rate, LEADS, STALE_MIN, SHRINK_M } from './model.mjs';
import { SEVERE, normFlag } from './codes.mjs';

export const DISEASES = Object.keys(SEVERE).filter((k) => k !== 'MKioskTy28');
export const diseaseBucket = (r) => (r.flag === 'N' ? 'dN' : bedBucket(r.hvec));
export const diseaseReject = (r) => r.hvec <= 0 || r.flag === 'N';

// bedRows: scripts/load.mjs의 loadSnapshots 결과, severeByKey: `${t}|${hpid}` → 중증질환 행
export function buildDiseaseModels(bedRows, severeByKey, { diseases = DISEASES } = {}) {
  const out = { version: 1, createdAt: new Date().toISOString(), leads: LEADS, rejectDefinition: 'hvec <= 0 또는 그 질환 불가능', cross: {}, diseases: {} };
  for (const d of diseases) {
    const rows = [];
    for (const r of bedRows) {
      const s = severeByKey.get(`${r.t}|${r.hpid}`);
      const flag = s ? normFlag(s[d]) : null;
      if (flag) rows.push({ ...r, flag });
    }
    const m = buildModel(rows, { isReject: diseaseReject, bucketOf: diseaseBucket });
    const last = {}; // 병원별 마지막 표시 (후보 판단용)
    for (const r of rows) if (!last[r.hpid] || r.t > last[r.hpid].t) last[r.hpid] = { t: r.t, flag: r.flag };
    out.diseases[d] = {
      pairs: m.pairs,
      pooled: m.pooled,
      hospitals: Object.fromEntries(Object.entries(m.hospitals).map(([h, v]) => [h, { counts: v.counts, base: v.base, lastFlag: last[h]?.flag }])),
    };
    for (const [k, c] of Object.entries(m.pooled)) {
      const x = (out.cross[k] ??= { n: 0, k: 0 });
      x.n += c.n;
      x.k += c.k;
    }
  }
  return out;
}

function explainDiseaseBase(dm, { disease, hpid, hb, m }) {
  const D = dm.diseases[disease];
  const prior = rate(dm.cross[`base|${hb}`]) ?? 0.1;
  const dAll = shrink(D?.pooled[`base|${hb}`], prior, m);
  return { fallback: true, p: shrink(D?.hospitals[hpid]?.base[String(hb)], dAll, m) };
}

export function explainDiseasePoint(dm, { disease, hpid, b, L, hb, m = SHRINK_M }) {
  const D = dm.diseases[disease];
  const cross = rate(dm.cross[`${b}|${L}|all`]);
  if (cross == null) return explainDiseaseBase(dm, { disease, hpid, hb, m });
  const dAll = shrink(D?.pooled[`${b}|${L}|all`], cross, m);
  const dHour = shrink(D?.pooled[`${b}|${L}|${hb}`], dAll, m);
  const p = shrink(D?.hospitals[hpid]?.counts[`${b}|${L}|${hb}`], dHour, m);
  return { cross, dAll, dHour, p };
}

// rejectProb({ hpid, hvec, flag('Y'|'N'|null), ageMin, leadMin, hourKST }) -> { p, basis }
export function makeDiseaseRejectProb(dm, disease, { m = SHRINK_M } = {}) {
  return ({ hpid, hvec, flag, ageMin = 0, leadMin, hourKST }) => {
    const hb = hourBin(hourKST);
    if (!flag) return { p: null, basis: '정보미제공: 확인 필요' };
    if (!Number.isFinite(hvec) || ageMin > STALE_MIN) return { p: explainDiseaseBase(dm, { disease, hpid, hb, m }).p, basis: '현재 상태 모름: 평균' };
    const b = flag === 'N' ? 'dN' : bedBucket(hvec);
    const p0 = hvec <= 0 || flag === 'N' ? 1 : 0;
    if (leadMin <= 0) return { p: p0, basis: '지금 상태' };
    let prevL = 0, prevP = p0;
    for (const L of dm.leads) {
      const pL = explainDiseasePoint(dm, { disease, hpid, b, L, hb, m }).p;
      if (leadMin <= L) return { p: prevP + ((leadMin - prevL) / (L - prevL)) * (pL - prevP), basis: '현재 상태 + 도착까지 시간' };
      prevL = L;
      prevP = pL;
    }
    return { p: prevP, basis: '현재 상태 + 도착까지 시간(최대 구간)' };
  };
}
