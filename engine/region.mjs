// 주소 → 시도·시군구 (수집 범위: 서울특별시·인천광역시·경기도)
// 서울과 인천에는 같은 이름의 구(중구·동구·서구 등)가 있어, 경기도가 아니면 시군구 앞에 시도 약칭을 붙인다.
// 경기도는 예전과 같이 시군 이름만 쓴다(기존 기록·화면과 이어지게).
export const SIDO_SHORT = { 서울특별시: '서울', 인천광역시: '인천', 경기도: '경기' };

export function regionOf(addr = '') {
  const [sido = '', gu = ''] = String(addr).trim().split(/\s+/);
  const short = SIDO_SHORT[sido] ?? sido;
  return { sido, si: !gu ? '' : sido === '경기도' ? gu : `${short} ${gu}` };
}
