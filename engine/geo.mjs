// 거리 계산 (위도·경도는 도 단위, 결과는 미터)
//   직선 거리: 지구를 공 모양으로 보고 두 점 사이의 가장 짧은 거리 (하버사인 공식)
//   (이 프로젝트에서 '택시거리'는 실제 도로 이동 거리이며, 카카오 길찾기 값을 쓴다. 격자 방식 계산은 2026-10-28 정리하며 뺐다)

const R = 6371000; // 지구 반지름 (m)
const RAD = Math.PI / 180;

export function haversineM(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
