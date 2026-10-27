// 수집한 가용병상 CSV(날짜별 파일)를 읽어 통계에 쓰는 형태로 바꾼다.
// 필요한 열: collected_at, hpid, dutyName, hvidate, hvec, hvs01 (이 열만 빠르게 읽는다)
export const BED_COLS = ['collected_at', 'hpid', 'dutyName', 'hvidate', 'hvec', 'hvs01'];
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseCSV, readColumns } from '../engine/csv.mjs';
import { parseKST, parseHvidate } from '../engine/time.mjs';

export function loadSnapshots(dir) {
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort();
  const rows = [];
  const timeOf = new Map(); // 같은 수집 시각 글자는 한 번만 변환
  for (const f of files) {
    for (const r of readColumns(readFileSync(join(dir, f), 'utf8'), BED_COLS)) {
      let t = timeOf.get(r.collected_at);
      if (t === undefined) timeOf.set(r.collected_at, (t = parseKST(r.collected_at)));
      const hv = parseHvidate(r.hvidate);
      const hvec = r.hvec === '' ? NaN : Number(r.hvec);
      rows.push({
        t,
        hpid: r.hpid,
        name: r.dutyName,
        hvec,
        hvs01: r.hvs01 === '' || r.hvs01 == null ? NaN : Number(r.hvs01),
        ageMin: hv == null ? Infinity : (t - hv) / 60e3,
      });
    }
  }
  return { files, rows };
}

// 중증질환 수용가능정보 CSV → `${수집 시각(ms)}|${hpid}` 로 찾는 표 (가용병상과 같은 실행에서 같은 시각으로 저장된다)
export function loadSevereByKey(dir) {
  const map = new Map();
  if (!existsSync(dir)) return map;
  for (const f of readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(x)).sort()) {
    for (const r of parseCSV(readFileSync(join(dir, f), 'utf8'))) map.set(`${parseKST(r.collected_at)}|${r.hpid}`, r);
  }
  return map;
}

// 자동 수집이 자리 잡은 시각: 처음으로 '다음 두 번의 수집 간격이 모두 15분 이하'가 된 수집 시각.
// 그 전(설정하며 손으로 몇 번 돌린 시험 수집)은 수집률 계산에서 빼려고 쓴다. 정렬된 시각(ms) 배열을 받는다.
export function regularStart(ts, maxGapMin = 15) {
  const g = maxGapMin * 60e3;
  for (let i = 0; i + 2 < ts.length; i++) if (ts[i + 1] - ts[i] <= g && ts[i + 2] - ts[i + 1] <= g) return ts[i];
  return ts[0] ?? null;
}
