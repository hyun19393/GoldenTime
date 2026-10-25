// 실효 도착 시간 계산
//
// 첫 병원 i를 골랐을 때:
//   실효 도착 시간 E(i) = 이동 시간(i) + 거절 확률(i) × 추가 시간(i)
//   추가 시간(i)     = 확인 지연 + (i에서 출발해 다음 병원으로 갈 때의 실효 도착 시간 중 최솟값)
// 다음 병원도 같은 식으로 계산하므로, 거절이 이어지는 경우(뺑뺑이)까지 depth 단계만큼 반영된다.
// 마지막 단계의 병원은 받아준다고 보고 끝내며, 그래도 남는 확률은 unresolved로 따로 알려준다.
//
// 거절 확률은 출발 시점에 확인한 각 병원의 상태와 '출발부터 그 병원 도착까지 걸린 시간'으로 정해진다.
// (가정) 병원끼리의 거절은 서로 독립으로 계산한다. 실제로는 주변 병원이 함께 붐비는 경우가 있어
//        과거 기록 재현으로 따로 검증한다.

/**
 * @param {Array<{id:string,name?:string,travelMin:number}>} candidates 출발지에서 각 병원까지 도로 이동 시간(분)
 * @param {(fromId:string,toId:string)=>number} between 병원 사이 도로 이동 시간(분)
 * @param {(id:string, leadMin:number)=>number} probAt 출발 후 leadMin분에 도착할 때 거절 확률
 * @param {{delayMin?:number, depth?:number}} opts delayMin: 거절당한 병원에서 다시 출발하기까지 걸리는 시간(가정값)
 */
export function evaluate(candidates, between, probAt, { delayMin = 3, depth = 3 } = {}) {
  const ids = candidates.map((c) => c.id);
  const nameOf = Object.fromEntries(candidates.map((c) => [c.id, c.name ?? c.id]));

  // fromId에서 (elapsed분에) 다시 출발할 때, 남은 병원 중 가장 좋은 선택과 그 기대 시간
  function bestNext(fromId, elapsed, visited, levels) {
    let best = null;
    for (const j of ids) {
      if (visited.has(j)) continue;
      const tt = between(fromId, j);
      if (!Number.isFinite(tt)) continue;
      const arrive = elapsed + tt;
      const p = probAt(j, arrive);
      let cont = 0;
      let rest = [];
      let unresolved = p;
      if (levels > 1) {
        const next = new Set(visited).add(j);
        const sub = bestNext(j, arrive + delayMin, next, levels - 1);
        if (sub) {
          cont = delayMin + sub.expected;
          rest = sub.chain;
          unresolved = p * sub.unresolved;
        }
      }
      const expected = tt + p * cont;
      if (!best || expected < best.expected) {
        best = { expected, unresolved, chain: [{ id: j, name: nameOf[j], travelMin: tt, arriveMin: arrive, p }, ...rest] };
      }
    }
    return best;
  }

  return candidates
    .filter((c) => Number.isFinite(c.travelMin))
    .map((c) => {
      const p = probAt(c.id, c.travelMin);
      let expected = c.travelMin;
      let unresolved = p;
      let chain = [{ id: c.id, name: nameOf[c.id], travelMin: c.travelMin, arriveMin: c.travelMin, p }];
      if (depth > 1) {
        const sub = bestNext(c.id, c.travelMin + delayMin, new Set([c.id]), depth - 1);
        if (sub) {
          expected = c.travelMin + p * (delayMin + sub.expected);
          unresolved = p * sub.unresolved;
          chain = chain.concat(sub.chain);
        }
      }
      return {
        id: c.id,
        name: nameOf[c.id],
        travelMin: c.travelMin,
        pReject: p,
        extraMin: expected - c.travelMin, // 거절 가능성 때문에 늘어나는 평균 시간
        effectiveMin: expected,
        chain, // 거절이 이어질 때 가게 되는 순서
        unresolved, // 계산한 단계까지 모두 거절될 확률
      };
    })
    .sort((a, b) => a.effectiveMin - b.effectiveMin);
}
