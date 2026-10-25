// 거리 계산 (위도·경도는 도 단위, 결과는 미터)
//   직선 거리: 지구를 공 모양으로 보고 두 점 사이의 가장 짧은 거리 (하버사인 공식)
//   택시거리: 두 점 근처를 평면으로 펴서 '동서 방향 거리 + 남북 방향 거리' (택시기하)
//             도로가 바둑판처럼 동서·남북으로 나 있다고 가정한 거리다.

const R = 6371000; // 지구 반지름 (m)
const RAD = Math.PI / 180;

export function haversineM(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// 동서(dx)·남북(dy) 방향 거리. 경도 1도의 길이는 위도가 높을수록 cos(위도)배로 줄어든다.
// 수십 km 안에서는 평면으로 펴도 오차가 매우 작다.
export function planeDeltaM(a, b) {
  const midLat = ((a.lat + b.lat) / 2) * RAD;
  return { dx: (b.lon - a.lon) * RAD * R * Math.cos(midLat), dy: (b.lat - a.lat) * RAD * R };
}

export function taxiM(a, b) {
  const { dx, dy } = planeDeltaM(a, b);
  return Math.abs(dx) + Math.abs(dy);
}
