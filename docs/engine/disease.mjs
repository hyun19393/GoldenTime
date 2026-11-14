// 질환별 안내 (웹앱 v3 베타)
//
// 고른 질환에 대해 병원을 세 단계로 나눈다.
//   ok    가능 확인: 그 질환의 공공데이터 표시가 모두 '가능'이고, 걸리는 메시지가 없다 → 실효 도착 시간으로 순위를 매긴다
//   check 확인 필요: 표시가 '정보미제공'이거나, 걸리는 메시지가 있다 → 확률을 붙이지 않고 이동 시간만 보여 준다
//   no    불가 표시: 그 질환(또는 응급실)이 지금 '불가능'으로 표시돼 있다 → 계산에서 뺀다
//
// 쓰는 자료는 수집기가 이미 받고 있는 세 가지뿐이다.
//   ① 중증질환 수용가능정보(27개 항목 + 응급실)  ② 응급실·중증질환 메시지  ③ 실시간 가용병상(거절 확률, engine/model.mjs)
// 가용병상의 수술실·중환자실·장비 칸은 활용가이드로 뜻을 확인해 참고 정보로만 보여 준다(파일 끝의 RES). 판단(assess)에는 쓰지 않는다.
//
// 근거 (2026-11-01 12:20 ~ 11-14, 서울·인천·경기 152곳, 질환 표시 짝 약 290만 개)
//   '가능' → 10분 뒤 '불가능' 0.0069%, 60분 뒤 0.0417% (도착까지 시간에 비례) → SEV_FLIP_PER_MIN
//   '불가능' → 30분 뒤에도 '불가능' 99.5%  → 지금 '불가능'이면 뺀다
//   응급실 전체에 걸린 부정 메시지가 있는 동안 병상 0 이하는 10.7%뿐 → 병상 수만으로는 이런 거절을 알 수 없다
import { SEVERE, MSG_TO_SEVERE } from './codes.mjs';

// '가능'이 1분 뒤 '불가능'으로 바뀌는 비율 (60분 뒤 1,200 / 2,875,904 를 60으로 나눔). 정기 점검 때 다시 잰다.
export const SEV_FLIP_PER_MIN = 1200 / 2875904 / 60;
// 항목 n개가 모두 '가능'일 때, leadMin분 뒤 하나라도 '불가능'으로 바뀔 확률 (항목끼리 독립이라고 가정, 값이 아주 작아 영향은 0.1%p 미만)
export const flipProb = (leadMin, n = 1) => (n > 0 ? 1 - (1 - Math.min(1, SEV_FLIP_PER_MIN * Math.max(0, leadMin))) ** n : 0);

export const itemLabel = (n) => SEVERE[`MKioskTy${n}`];

// 질환 목록. items = 공공데이터 항목 번호(MKioskTy n), depts = 관련 진료과(메시지의 진료과 칸·글과 맞춰 봄), words = 메시지 글에서 찾는 낱말
// depts·words는 '관련 메시지'를 고르려고 정해 둔 규칙이다(가정). 걸리지 않은 메시지도 병원을 누르면 모두 보여 준다.
// accept = 이 낱말이 있으면 '이 환자는 받는다'는 글로 본다 (심정지: 'CPR만 가능', 'CPR 외 수용불가' 등. 'CPR 포함 수용불가'는 제외)
// words는 정규식 조각으로 합쳐 한 번에 찾는다(대소문자 구분 없음)
const D = (id, group, label, items, depts = [], words = [], note = '', accept = null) =>
  ({ id, group, label, items, depts, words, wordRe: words.length ? new RegExp(words.join('|'), 'i') : null, note, accept });
const NO_DATA = '이 경우는 병원별 수용 가능 정보가 공공데이터에 없어요. 응급실 병상과 병원 메시지만으로 계산해요.';
export const DISEASES = [
  D('none', '', '모름 · 고르지 않음', []),
  D('mi', '심장·큰 혈관', '심근경색', [1], ['순환기내과', '심장혈관흉부외과', '흉부외과', '내과'], ['심근경색', 'AMI', 'CAG', '흉통', '심혈관']),
  D('aortaT', '심장·큰 혈관', '대동맥 응급 (흉부)', [5], ['심장혈관흉부외과', '흉부외과'], ['대동맥']),
  D('aortaA', '심장·큰 혈관', '대동맥 응급 (복부)', [6], ['심장혈관흉부외과', '흉부외과', '외과'], ['대동맥']),
  D('stroke', '뇌', '뇌경색', [2], ['신경과', '신경외과'], ['뇌경색', '뇌졸중', 'stroke', '뇌혈관']),
  D('ich', '뇌', '뇌출혈 (종류 모름)', [3, 4], ['신경외과'], ['뇌출혈', '뇌혈관', 'ICH', 'SAH']),
  D('sah', '뇌', '뇌출혈: 거미막하출혈', [3], ['신경외과'], ['뇌출혈', '뇌혈관', 'SAH']),
  D('ichx', '뇌', '뇌출혈: 거미막하출혈 외', [4], ['신경외과'], ['뇌출혈', '뇌혈관', 'ICH']),
  D('abd', '배', '복부 응급수술 (다쳐서 생긴 것 아님)', [9], ['외과'], ['복부', '천공']),
  D('gall', '배', '담낭·담관 질환 (종류 모름)', [7, 8], ['외과', '소화기내과', '내과'], ['담낭', '담관', '담도', 'ERCP']),
  D('gi', '배', '위장관 응급내시경 (성인)', [11], ['소화기내과', '내과'], ['위장관', '내시경', '토혈']),
  D('giC', '배', '위장관 응급내시경 (영유아)', [12], ['소아청소년과'], ['위장관', '내시경', '소아']),
  D('intus', '배', '장중첩·폐색 (영유아)', [10], ['소아청소년과', '외과'], ['장중첩', '소아']),
  D('bronch', '숨', '기관지 응급내시경 (성인)', [13], ['호흡기내과', '흉부외과', '내과'], ['기관지']),
  D('bronchC', '숨', '기관지 응급내시경 (영유아)', [14], ['소아청소년과'], ['기관지', '소아']),
  D('delivery', '임신·신생아', '분만', [16], ['산부인과'], ['분만', '산모', '산과']),
  D('obOp', '임신·신생아', '산과 수술', [17], ['산부인과'], ['산과', '산모']),
  D('gynOp', '임신·신생아', '부인과 수술', [18], ['산부인과'], ['부인과']),
  D('lbw', '임신·신생아', '저체중 출생아 집중치료', [15], ['소아청소년과'], ['신생아', '미숙아', 'NICU']),
  D('burn', '화상·접합', '중증 화상', [19], ['외과', '성형외과'], ['화상']),
  D('replant', '화상·접합', '손가락·발가락 접합 (수족지접합)', [20], ['정형외과', '성형외과'], ['접합', '절단']),
  D('replantX', '화상·접합', '팔·다리 접합 (수족지접합 외)', [21], ['정형외과', '성형외과'], ['접합', '절단']),
  D('hd', '그 밖', '응급 투석 (HD)', [22], ['신장내과', '내과'], ['투석']),
  D('crrt', '그 밖', '응급 투석 (CRRT)', [23], ['신장내과', '내과'], ['투석', 'CRRT']),
  D('psy', '그 밖', '정신과 응급 (폐쇄병동 입원)', [24], ['정신건강의학과'], ['정신']),
  D('eye', '그 밖', '안과 응급수술', [25], ['안과'], ['안과', '안외상']),
  D('ir', '그 밖', '영상의학 혈관중재 (성인)', [26], ['영상의학과'], ['색전', '혈관조영', '혈관중재']),
  D('irC', '그 밖', '영상의학 혈관중재 (영유아)', [27], ['영상의학과', '소아청소년과'], ['색전', '혈관조영', '혈관중재']),
  D('arrest', '공공데이터에 질환 정보가 없는 경우', '심정지', [], [], ['CPR', '심정지'], NO_DATA, /CPR(?!\s*포함)/i),
  D('trauma', '공공데이터에 질환 정보가 없는 경우', '중증외상 (교통사고·추락·깔림 등)', [], [], ['(^|[^비])외상'], NO_DATA), // '비외상'은 빼고 찾는다
  D('fracture', '공공데이터에 질환 정보가 없는 경우', '골절', [], ['정형외과'], ['골절'], NO_DATA),
];
export const diseaseById = Object.fromEntries(DISEASES.map((d) => [d.id, d]));

// ---- 메시지 글 규칙 (글 규칙은 틀릴 수 있어, 화면에는 늘 메시지 원문을 함께 보여 준다)
// 사전 연락이 필요한 글: '사전 문의', '문의 후 이송', '수용 여부 확인' 등. '전문의'의 '문의'에 속지 않게 먼저 지운다.
const CONTACT_RE = /(사전|미리|먼저)\s*(에\s*)?(문의|연락|협의|확인|상의|전화|통보)|(문의|연락|협의|상의|통보|고지\)?|확인)\s*(후|필수|요망|바랍니다|바람|부탁|필요)|수용\s*(여부|문의)|전화\s*(문의|부탁)/;
// 병원 사이 전원(옮기기)만 말하는 글은 현장 이송의 사전 연락으로 보지 않는다
const TRANSFER_ONLY = (t) => /전원/.test(t) && !/이송|119|내원/.test(t);
export const isContact = (text) => { const t = String(text ?? '').replace(/전문의/g, ''); return CONTACT_RE.test(t) && !TRANSFER_ONLY(t); };
// 받기 어렵다는 뜻의 낱말이 있는 글 ('24시간 진료 가능' 같은 안내 글과 구분)
const NEG_RE = /불가|포화|과밀|자제|제한|부족|부재|없음|여석|중단|지연|만\s*(진료\s*)?가능|어려|고장|점검|공사|over|full/i;
export const isNegative = (text) => NEG_RE.test(String(text ?? ''));
// 진료과 칸이 '응급실'인 메시지 중, 글이 특정 진료과·질환만 말하는 것 (응급실 전체 대상이 아님)
const TOPIC_RE = /안과|산부인과|산과|부인과|산모|소아|신생아|미숙아|NICU|stroke|정신|내과|이비인후과|성형|피부과|치과|비뇨|정형외과|신경과|신경외과|흉부외과|대동맥|담낭|내시경|뇌출혈|뇌졸중|AMI|ECMO|중독|외상|화상|투석|안면|얼굴/i;

// 글에서 진료과 이름 찾기: '순환기내과'를 '내과'로 잘못 잡지 않게, 앞 글자가 한글이면 다른 낱말로 본다
const deptReCache = {};
const deptRe = (x) => (deptReCache[x] ??= new RegExp(`(^|[^가-힣])${x}`));

const itemOfCode = (code) => Number((MSG_TO_SEVERE[code] ?? '').replace('MKioskTy', '')) || 0; // Y000(응급실)은 28

// 메시지 m이 질환 d와 어떤 관계인가: 'item' 그 질환 항목의 메시지 · 'word' 글에 낱말 · 'dept' 관련 진료과 · 'er' 응급실 전체(병상·장비 포함) · null 관계없음
export function scopeOf(m, d) {
  if (m.c !== 'Y000') return d.items.includes(itemOfCode(m.c)) ? 'item' : null;
  const t = String(m.t ?? '');
  if (d.wordRe?.test(t)) return 'word';
  if (d.depts.includes(m.d) || d.depts.some((x) => deptRe(x).test(t))) return 'dept';
  if (m.d === '응급실' || m.d === '병상 또는 장비' || !m.d) return TOPIC_RE.test(t) ? null : 'er';
  return null;
}

/**
 * 병원 하나를 질환 d 기준으로 판단한다.
 * @param {{f?:string, m?:Array<{c:string,d:string,t:string}>}|undefined} h  f = 항목 1~27과 응급실(28)의 표시 28글자 ('Y' 가능 · 'N' 불가능 · '-' 정보미제공)
 * @returns {{tier:'ok'|'check'|'no', why:string[], noItems:number[], unknownItems:number[], rel:object[], other:object[], contact:object[]}}
 */
export function assess(h, d) {
  const f = h?.f ?? '';
  const flag = (n) => f[n - 1] ?? '-';
  const noItems = d.items.filter((n) => flag(n) === 'N');
  const unknownItems = d.items.filter((n) => flag(n) !== 'Y' && flag(n) !== 'N');
  const rel = [], other = [], contact = [];
  let itemMsg = 0, blockMsg = 0;
  for (const m of h?.m ?? []) {
    const scope = scopeOf(m, d);
    if (!scope) { other.push(m); continue; }
    const accepts = scope !== 'item' && !!d.accept?.test(m.t); // 이 환자는 받는다는 글 → 막는 메시지·사전 연락으로 세지 않는다
    const c = !accepts && isContact(m.t);
    const block = scope === 'item' || (!accepts && (c || isNegative(m.t)));
    rel.push({ ...m, scope, contact: c, block });
    if (c) contact.push(m);
    if (scope === 'item') itemMsg++;
    else if (block) blockMsg++;
  }
  const why = [];
  let tier = 'ok';
  if (flag(28) === 'N') { tier = 'no'; why.push("응급실 '불가능' 표시"); }
  if (noItems.length) { tier = 'no'; why.push(...noItems.map((n) => `${itemLabel(n)} '불가능' 표시`)); }
  if (tier !== 'no') {
    if (unknownItems.length) { tier = 'check'; why.push(d.items.length > 1 && unknownItems.length < d.items.length ? '일부 항목 정보 없음' : '질환 정보 없음'); }
    if (itemMsg) { tier = 'check'; why.push(`이 질환 메시지 ${itemMsg}건`); }
    if (blockMsg) { tier = 'check'; why.push(`관련 메시지 ${blockMsg}건`); }
    if (contact.length) why.push('사전 연락 필요');
  }
  return { tier, why, noItems, unknownItems, rel, other, contact };
}

// ---- 병원이 알린 자원 (가용병상 API의 수술실·중환자실·장비 칸)
// 칸 이름과 뜻은 공공데이터포털 활용가이드(국립중앙의료원 전국 응급의료기관 정보 조회 서비스 V1.3)의 '응급실 실시간 가용병상정보' 표 그대로다.
// 숫자 칸은 남은 수, 장비 칸은 'Y'가 가용. 장비 칸의 'N'·'N1'은 가이드에 뜻이 없어 "가용 표시 아님"으로만 보여 준다.
export const RES = {
  hvoc: '수술실', hv39: '외상전용 수술실', hv60: '외상소생실', hv42: '분만실', hv43: '화상전용처치실',
  hvicc: '일반 중환자실', hvcc: '신경과 중환자실', hvccc: '흉부외과 중환자실', hvncc: '신생아 중환자실',
  hv2: '내과 중환자실', hv3: '외과 중환자실', hv6: '신경외과 중환자실', hv9: '외상 중환자실', hv32: '소아 중환자실', hv34: '심장내과 중환자실',
  hvctayn: 'CT', hvmriayn: 'MRI', hvangioayn: '혈관촬영기', hvincuayn: '인큐베이터', hvventisoayn: '인공호흡기(조산아)',
  hvcrrtayn: 'CRRT', hvecmoayn: 'ECMO', hvhypoayn: '중심체온조절유도기',
};
// 질환마다 함께 보여 줄 자원. 순위·확률에는 쓰지 않는 참고 정보다 (어떤 자원이 꼭 필요한지는 환자마다 달라 공공데이터로 정할 수 없다)
export const DISEASE_RES = {
  none: ['hvoc', 'hvicc'],
  mi: ['hvangioayn', 'hv34', 'hvccc', 'hvecmoayn'], aortaT: ['hvoc', 'hvccc', 'hvctayn'], aortaA: ['hvoc', 'hvccc', 'hvctayn'],
  stroke: ['hvctayn', 'hvmriayn', 'hvangioayn', 'hvcc'], ich: ['hvctayn', 'hvangioayn', 'hvoc', 'hv6'], sah: ['hvctayn', 'hvangioayn', 'hvoc', 'hv6'], ichx: ['hvctayn', 'hvoc', 'hv6'],
  abd: ['hvoc', 'hv3'], gall: ['hvoc', 'hv3'], gi: ['hv2'], giC: ['hv32'], intus: ['hvoc', 'hv32'], bronch: ['hv2'], bronchC: ['hv32'],
  delivery: ['hv42', 'hvoc'], obOp: ['hvoc', 'hv42'], gynOp: ['hvoc'], lbw: ['hvncc', 'hvincuayn', 'hvventisoayn'],
  burn: ['hv43'], replant: ['hvoc'], replantX: ['hvoc'], hd: ['hvicc'], crrt: ['hvcrrtayn', 'hvicc'], psy: [], eye: ['hvoc'], ir: ['hvangioayn'], irC: ['hvangioayn', 'hv32'],
  arrest: ['hvicc', 'hvecmoayn', 'hvhypoayn'], trauma: ['hvoc', 'hv39', 'hv60', 'hv9', 'hvctayn'], fracture: ['hvoc'],
};
export const RES_KEYS = Object.keys(RES);
/** 병원 자원 r(severe.json의 r)에서 질환 d에 맞는 것만. 값이 없는 칸은 뺀다. → [{key, label, text, low}] (low: 0 이하이거나 가용 표시 아님) */
export function resources(r, d) {
  const out = [];
  for (const key of DISEASE_RES[d.id] ?? []) {
    const v = r?.[key];
    if (v == null || v === '') continue;
    const eq = key.endsWith('yn');
    if (eq) out.push({ key, label: RES[key], text: v === 'Y' ? `${RES[key]} 가용` : `${RES[key]} 가용 표시 아님`, low: v !== 'Y' });
    else if (/^-?\d+$/.test(String(v))) out.push({ key, label: RES[key], text: `${RES[key]} ${v}`, low: Number(v) <= 0 });
    else out.push({ key, label: RES[key], text: v === 'Y' ? `${RES[key]} 가용` : `${RES[key]} 가용 표시 아님`, low: v !== 'Y' }); // 분만실·화상전용처치실은 Y/N으로 온다
  }
  return out;
}
