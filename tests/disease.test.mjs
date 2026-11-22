import test from 'node:test';
import assert from 'node:assert/strict';
import { DISEASES, diseaseById, assess, scopeOf, isContact, isNegative, flipProb, SEV_FLIP_PER_MIN, itemLabel, itemMsgKind } from '../engine/disease.mjs';
import { SEVERE } from '../engine/codes.mjs';

const flags = (set = {}) => Array.from({ length: 28 }, (_, i) => set[i + 1] ?? (i === 27 ? 'Y' : '-')).join('');
const msg = (c, d, t) => ({ c, d, t });

test('질환 목록: 아이디가 겹치지 않고, 항목 번호는 공공데이터 1~27 안, 27개 항목을 모두 고를 수 있다', () => {
  assert.equal(new Set(DISEASES.map((d) => d.id)).size, DISEASES.length);
  const used = new Set(DISEASES.flatMap((d) => d.items));
  for (const n of used) assert.ok(SEVERE[`MKioskTy${n}`], `항목 ${n}`);
  assert.equal(used.size, 27);
  assert.equal(itemLabel(3), '[뇌출혈수술] 거미막하출혈');
});

test("표시: 모두 '가능'이면 가능 확인, 하나라도 '불가능'이면 불가, 정보미제공이면 확인 필요", () => {
  const ich = diseaseById.ich;
  assert.equal(assess({ f: flags({ 3: 'Y', 4: 'Y' }) }, ich).tier, 'ok');
  const no = assess({ f: flags({ 3: 'Y', 4: 'N' }) }, ich);
  assert.equal(no.tier, 'no');
  assert.deepEqual(no.noItems, [4]);
  const part = assess({ f: flags({ 3: 'Y' }) }, ich);
  assert.equal(part.tier, 'check');
  assert.deepEqual(part.why, ['일부 항목 정보 없음']);
  assert.deepEqual(assess({ f: flags() }, ich).why, ['질환 정보 없음']);
  assert.equal(assess(undefined, ich).tier, 'check'); // 질환 정보에 없는 병원
  assert.equal(assess({ f: flags({ 3: 'Y', 4: 'Y', 28: 'N' }) }, ich).tier, 'no'); // 응급실 불가능
});

test('고르지 않으면 표시와 상관없이 병상만: 응급실 전체 메시지가 없으면 가능 확인', () => {
  assert.equal(assess({ f: flags() }, diseaseById.none).tier, 'ok');
  assert.equal(assess(undefined, diseaseById.none).tier, 'ok');
});

test('그 질환 항목의 메시지가 있으면 표시가 가능이어도 확인 필요', () => {
  const r = assess({ f: flags({ 1: 'Y' }), m: [msg('Y0010', '', '08:30-13:30 심근경색 재관류 불가')] }, diseaseById.mi);
  assert.equal(r.tier, 'check');
  assert.deepEqual(r.why, ['이 질환 메시지 1건']);
  assert.equal(assess({ f: flags({ 2: 'Y' }), m: [msg('Y0010', '', 'x 불가')] }, diseaseById.stroke).tier, 'ok'); // 다른 항목의 메시지
});

test('질환 항목 메시지 글 종류: 수집 29일에 실제로 나온 글 (불가 · 부족 · 그 밖)', () => {
  for (const t of ['불가능메세지등록', '일시적 불가', '진료과 사정으로 복부 응급수술 불가', '담당 전문의 부재로 angio 불가', '시설공사로 14병상으로 축소운영. 신환수용 불가.', '정신과환자 전문의 부재로 수용불가능', 'CRRT 불가능'])
    assert.equal(itemMsgKind(t), 'no', t);
  for (const t of ['의료진 부족', '의료진 부족으로 수용 어려움', 'ICU full bed', 'ICU over', 'CRRT 사용중', '수술장 포화', 'ICU 여석 없음', 'ASU, ICU 공상 없음', '심장내과 전문의 부재'])
    assert.equal(itemMsgKind(t), 'short', t);
  for (const t of ['ERCP불가', '담당 전문의 부재로 응급 ERCP불가', '기관지 응급내시경(성인) 야간(18:00 ~ 08:00) ,주말, 공휴일 불가', '[안과적 응급 수술] 정규시간 외 응급수술 불가능(마취지원 불가)',
    '11월 19일~21일까지 소아 위장관 불가 (전문의 부재)', '08:30-13:30 심근경색 재관류 불가', '외래진료만 가능', '부분제공으로 해당일 진료 불가능', 'Brain part 전원 수용불가',
    '응급검사 및 시술 필요한 환자 수용 불가', 'NS vascular part 시술 중, Trauma part 가능', '정전및 점검', 'CAG 진행중', '**산부인과 수술의 부족 / 격주 당직**', '당직의 부재', ''])
    assert.equal(itemMsgKind(t), null, t);
});

test("질환 항목 표시가 정보미제공인데 불가·부족 글이 걸려 있으면 불가 표시, '가능' 표시와 '불가' 글이 다르면 확인 필요", () => {
  const mi = diseaseById.mi;
  for (const t of ['불가능메세지등록', '의료진 부족']) {
    const r = assess({ f: flags({ 1: '-' }), m: [msg('Y0010', '', t)] }, mi);
    assert.equal(r.tier, 'no', t);
    assert.deepEqual(r.why, [`${itemLabel(1)} 불가 메시지`]);
    assert.equal(r.rel[0].no, true);
  }
  const cond = assess({ f: flags({ 1: '-' }), m: [msg('Y0010', '', '야간(18:00 ~ 08:00),주말, 공휴일 불가')] }, mi);
  assert.equal(cond.tier, 'check'); // 시간 조건 글은 그대로
  assert.deepEqual(cond.why, ['질환 정보 없음', '이 질환 메시지 1건']);
  const conf = assess({ f: flags({ 1: 'Y' }), m: [msg('Y0010', '', '불가능메세지등록')] }, mi);
  assert.equal(conf.tier, 'check');
  assert.deepEqual(conf.why, ["'가능' 표시와 '불가' 메시지가 서로 달라요"]);
  const short = assess({ f: flags({ 1: 'Y' }), m: [msg('Y0010', '', 'ICU 여석 없음')] }, mi);
  assert.deepEqual([short.tier, short.why], ['check', ['이 질환 메시지 1건']]); // 부족 글은 '가능' 표시와 함께 나온 때가 많아 다르다고 하지 않는다
  assert.equal(assess({ f: flags({ 1: 'N' }), m: [msg('Y0010', '', '불가능메세지등록')] }, mi).tier, 'no'); // 원래 불가능 표시
  assert.equal(assess({ f: flags({ 2: '-' }), m: [msg('Y0010', '', '불가능메세지등록')] }, diseaseById.stroke).tier, 'check'); // 다른 항목의 글은 영향 없음
});

test('사전 연락 글: 전문의의 문의에 속지 않고, 전원만 말하는 글은 뺀다', () => {
  for (const t of ['산부인과 사전 연락 후 수용여부 결정', '119 구급대원께서는 문의 후 이송 부탁드립니다.', '119 : Pre KTAS 1~2 환자 통보(고지) 후 내원',
    '[위장관 응급내시경(성인)] 반드시 수용 여부 사전 확인', 'f/u 은 미리 전화 부탁드립니다.', '환자 수용여부 확인 부탁드립니다.', '(필요 시 문의바랍니다.)'])
    assert.equal(isContact(t), true, t);
  for (const t of ['담당 전문의 부재로 angio 불가', '신경외과 전문의 부재', '전원 문의는 핫라인 무선전화(휴대폰)를 통해 연락 바랍니다.', '이송 및 전원에 참고 바랍니다.', '응급실 포화', '소아청소년과 : 24시간 진료 가능'])
    assert.equal(isContact(t), false, t);
});

test('받기 어렵다는 글과 안내 글 구분', () => {
  for (const t of ['응급실 포화', 'CPR 외 수용불가', '중환자실 full bed', '상시시간(외래진료가능시간)만 진료가능', '응급실 인력부족으로 경증환자 수용자제']) assert.equal(isNegative(t), true, t);
  for (const t of ['소아청소년과 : 24시간 진료 가능', '자해, 자살, 약물중독 환자 : 적극 수용', '소아 외상환자 수용가능']) assert.equal(isNegative(t), false, t);
});

test('메시지 범위: 응급실 전체 · 관련 진료과 · 낱말 · 관계없음', () => {
  const { ich, mi, none, abd } = diseaseById;
  assert.equal(scopeOf(msg('Y000', '응급실', '응급실 포화'), none), 'er');
  assert.equal(scopeOf(msg('Y000', '병상 또는 장비', '중환자실 full bed'), ich), 'er');
  assert.equal(scopeOf(msg('Y000', '응급실', '[안과] 응급 안과 적출에 준하는 상황의 경우, 안과 당직 문의 후 수용 여부 확인'), ich), null); // 응급실 칸이지만 안과 이야기
  assert.equal(scopeOf(msg('Y000', '신경외과', '신경외과 진료불가'), ich), 'dept');
  assert.equal(scopeOf(msg('Y000', '응급실', '[뇌출혈수술] 중환자실 여부에 따라 수용 가능 (필요 시 문의 바랍니다.)'), ich), 'word');
  assert.equal(scopeOf(msg('Y000', '감염내과', '감염내과 - 신환 수용 불가'), mi), null); // '감염내과'를 '내과'로 잡지 않는다
  assert.equal(scopeOf(msg('Y000', '응급실', '금일 내과 당직의 부재로 내과환자는 입원 불가합니다.'), mi), 'dept');
  assert.equal(scopeOf(msg('Y000', '성형외과', '성형외과 진료 불가능'), ich), null);
  assert.equal(scopeOf(msg('Y000', '외과', '[복부응급수술(비외상)]Appendicitis 신환 수용 불가'), abd), 'word');
});

test('응급실 전체 메시지: 받기 어렵다는 글이면 확인 필요, 안내 글이면 그대로 가능 확인', () => {
  const ok = { f: flags({ 3: 'Y', 4: 'Y' }) };
  assert.equal(assess({ ...ok, m: [msg('Y000', '응급실', '응급실 포화 CPR제외 이송자제')] }, diseaseById.ich).tier, 'check');
  const info = assess({ ...ok, m: [msg('Y000', '응급실', '전원 문의는 핫라인 무선전화(휴대폰)를 통해 연락 바랍니다.')] }, diseaseById.ich);
  assert.equal(info.tier, 'ok');
  assert.equal(info.rel.length, 1);
  const call = assess({ ...ok, m: [msg('Y000', '응급실', '119 구급대원께서는 문의 후 이송 부탁드립니다.'), msg('Y000', '피부과', '피부과 진료 불가')] }, diseaseById.ich);
  assert.equal(call.tier, 'check');
  assert.equal(call.contact.length, 1);
  assert.equal(call.other.length, 1);
  assert.deepEqual(call.why, ['관련 메시지 1건', '사전 연락 필요']);
});

test("'CPR만 가능' 같은 응급실 글은 다른 환자에게는 받기 어렵다는 글", () => {
  assert.equal(assess({ m: [msg('Y000', '응급실', '침상 및 모니터 부족으로 CPR만 가능합니다')] }, diseaseById.none).tier, 'check');
});

test('가능 → 불가능 바뀔 확률: 시간에 비례하고 항목이 많으면 조금 커진다', () => {
  assert.equal(flipProb(0, 1), 0);
  assert.ok(Math.abs(flipProb(60, 1) - 1200 / 2875904) < 1e-12);
  assert.ok(flipProb(30, 2) > flipProb(30, 1) && flipProb(30, 2) < 2 * flipProb(30, 1) + 1e-12);
  assert.equal(flipProb(30, 0), 0);
  assert.ok(SEV_FLIP_PER_MIN > 0 && SEV_FLIP_PER_MIN < 1e-4);
});

test('병원이 알린 자원: 질환에 맞는 칸만, 빈칸은 빼고, 0 이하·Y 아님은 low', async () => {
  const { resources, RES, DISEASE_RES, RES_KEYS, DISEASES, diseaseById } = await import('../engine/disease.mjs');
  for (const d of DISEASES) assert.ok(Array.isArray(DISEASE_RES[d.id]), d.id); // 모든 질환에 목록이 있다
  for (const keys of Object.values(DISEASE_RES)) for (const k of keys) assert.ok(RES[k], k); // 모르는 칸 이름이 없다
  assert.equal(RES_KEYS.length, Object.keys(RES).length);
  const r = { hvoc: 3, hv6: 0, hvctayn: 'Y', hvangioayn: 'N1' };
  assert.deepEqual(resources(r, diseaseById.ich).map((x) => [x.text, x.low]),
    [['CT 가용', false], ['혈관촬영기 가용 표시 아님', true], ['수술실 3', false], ['신경외과 중환자실 0', true]]);
  assert.deepEqual(resources(r, diseaseById.abd).map((x) => x.key), ['hvoc']); // 값이 없는 칸(hv3)은 안 보인다
  assert.deepEqual(resources(undefined, diseaseById.mi), []);
  assert.deepEqual(resources({ hv42: 'N', hvoc: -1 }, diseaseById.delivery).map((x) => [x.text, x.low]), [['분만실 가용 표시 아님', true], ['수술실 -1', true]]);
});

test('표시가 바뀔 확률: 24시간 그대로인 항목과 그렇지 않은 항목을 나눈다', async () => {
  const { flipProb2, stability, SEV_FLIP, diseaseById } = await import('../engine/disease.mjs');
  assert.equal(flipProb2(0, 1, 1), 0);
  assert.ok(Math.abs(flipProb2(60, 1, 0) - 695 / 3266782) < 1e-12);
  assert.ok(Math.abs(flipProb2(60, 0, 1) - 849 / 509645) < 1e-12);
  assert.ok(SEV_FLIP.unstable > 5 * SEV_FLIP.stable);
  assert.ok(flipProb2(30, 1, 1) > flipProb2(30, 2, 0) && flipProb2(30, 0, 0) === 0);
  const s = '0'.repeat(27).split(''); s[2] = '1'; s[3] = '1'; const h = { s: s.join('') };
  assert.deepEqual(stability(h, diseaseById.ich), { stable: 2, unstable: 0 }); // 항목 3·4
  assert.deepEqual(stability(h, diseaseById.mi), { stable: 0, unstable: 1 });
  assert.deepEqual(stability({ ...h, d: 1 }, diseaseById.ich), { stable: 0, unstable: 2 }); // 병상 급감이면 모두 불안정
  assert.deepEqual(stability(undefined, diseaseById.ich), { stable: 0, unstable: 2 }); // 정보가 없으면 조심스럽게
});

test('진료과 메시지가 분명히 수용 불가라고 적으면 불가 표시, 조건·대상이 좁으면 확인 필요', async () => {
  const { assess, isExplicitNo, diseaseById } = await import('../engine/disease.mjs');
  const W = ['산부인과', '소아청소년과', '신경외과', '소화기내과', '환자', '관련', '및'];
  for (const t of ['[소아청소년과] 진료불가', 'NICU 부재, 고위험산모실 부재 등으로 모든 산모 수용 불가', '시술불가', '불가능메세지등록', '[소아청소년과] 응급실 진료 불가'])
    assert.ok(isExplicitNo(t, W), t);
  for (const t of ['[신경외과] 경증 두부외상 수용 불가능', '소아청소년과 24개월미만 진료불가', '신경외과 - 주말/공휴일 진료불가', '위장관출혈 Part 전문의 부재로 수용 불가', '소아신경분과 의료진 인력부족으로 관련 환자 진료불가', '야간(18:00 ~ 08:00까지 불가능)', 'CPR 외 수용불가', '수용 가능'])
    assert.ok(!isExplicitNo(t, W), t);
  const Y = 'Y'.repeat(28);
  const h = { f: Y, m: [{ c: 'Y000', d: '산부인과', t: 'NICU 부재, 고위험산모실 부재 등으로 모든 산모 수용 불가' }] };
  assert.equal(assess(h, diseaseById.delivery).tier, 'no');
  assert.equal(assess(h, diseaseById.mi).tier, 'ok'); // 관계없는 질환은 그대로
  const h2 = { f: Y, m: [{ c: 'Y000', d: '신경외과', t: '[신경외과] 경증 두부외상 수용 불가능' }] };
  assert.equal(assess(h2, diseaseById.ich).tier, 'check');
});
