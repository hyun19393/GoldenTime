# 골든타임 경로 (가칭)

응급실 뺑뺑이 탐구 프로젝트. 출발할 때 '병상 있음'으로 보이던 응급실이 **도착했을 때도** 받아줄 수 있을지를 공공데이터 통계로 예측하고, 거절될 경우 다음 병원까지 가는 시간까지 더한 **실효 도착 시간**으로 응급실까지의 경로를 고른다.

> 교육·탐구용 프로젝트입니다. 실제 응급 상황에서는 119에 신고하세요.

## 계산 방법

1. **도로 이동 시간**: 길찾기 API(실시간 교통 반영)로 출발지 → 각 응급실, 응급실 → 응급실 시간을 구한다.
2. **도착 시점 거절 확률**: 수집한 기록에서 "지금 남은 병상이 k개였을 때, n분 뒤에 수용 불가 상태였던 비율"을 시간대별·병원별로 센다.
   - 수용 불가 상태(v1) = 응급실 가용병상 `hvec` ≤ 0 (음수는 정원 초과)
   - 병원 기록이 적으면 전체 통계 쪽으로 당겨서 쓴다
3. **실효 도착 시간** = 이동 시간 + 거절 확률 × (확인 지연 + 다음 병원까지의 실효 도착 시간)
   - 거절이 이어지는 경우를 3단계까지 계산한다

## 폴더

| 위치 | 내용 |
|---|---|
| `collector/collect.mjs` | 공공데이터 수집기 (cron-job.org가 10분마다 GitHub Actions를 실행) |
| `engine/model.mjs` | 거절 확률 통계표 만들기, 확률 계산 |
| `engine/effective.mjs` | 실효 도착 시간 계산 |
| `engine/geo.mjs` · `engine/stats.mjs` | 직선·택시거리 계산, 순위 상관 (웹앱 거리 비교) |
| `scripts/validate.mjs` | 앞 기간으로 만든 통계가 뒤 기간을 얼마나 맞히는지 검증 |
| `scripts/build-model.mjs` | 웹앱용 통계표 `model.json` 만들기 |
| `scripts/travel-matrix.mjs` | 응급실 사이 도로 이동 시간 표 (카카오 길찾기, 하루 4번 → `data/travel/`) |
| `scripts/build-web.mjs` | 웹앱용 파일 만들기: `docs/model.json`(거절 통계표), `docs/travel.json`(이동 시간표), `docs/engine/`(계산 코드 복사) |
| `docs/app.html` | 응급실 추천 웹앱 (카카오 지도, 출발지 → 실효 도착 시간 순위·경로) |
| `proxy/worker.js` | 중계 서버 (Cloudflare Workers): 카카오 키를 숨기고 웹앱의 길찾기 요청만 대신 호출 |
| `data/` | 수집 데이터 (날짜별 CSV) |
| `tests/` | 자동 검사 (`npm test`) |

## 수집 현황판

https://hyun19393.github.io/GoldenTime/ (GitHub Pages, `docs/` 폴더)

웹앱: https://hyun19393.github.io/GoldenTime/app.html (카카오 지도 JavaScript 키는 웹페이지에 공개되는 키라 코드에 들어 있고, 카카오 디벨로퍼스에 등록한 도메인에서만 작동한다. REST 키는 중계 서버 Secret에만 둔다.)

수집할 때마다 `scripts/build-status.mjs`가 `docs/status.json`을 새로 만들고, 현황판이 그 파일을 읽어 지도·그래프·표로 보여준다.

현황판의 '거절 확률은 이렇게 계산해요'는 `docs/model.json`(거절 통계표)을 웹앱과 같은 계산 코드로 읽어, 병상×도착 시간 표, 병원 하나의 단계별 계산식, 병원별 결과를 보여준다.

## 수집 데이터

출처: 공공데이터포털 「국립중앙의료원_전국 응급의료기관 정보 조회 서비스」

요청 변수와 항목 뜻은 「OpenAPI 활용가이드 V13」 기준.

| 파일 | 기능 | 주기 |
|---|---|---|
| `data/beds/날짜.csv` | ① 응급실 실시간 가용병상정보 조회 (`hvec` 응급실 일반병상, `hvs01` 일반 기준병상, `hv28` 소아 등) | 10분 |
| `data/severe/날짜.csv` | ② 중증질환자 수용가능정보 조회 (`MKioskTy1~28`, 질환 28종 Y/불가능/정보미제공) | 10분 |
| `data/messages/날짜.csv` | ⑨ 응급실 및 중증질환 메시지 조회 (수용 불가 메시지, 시작·해제 시각) | 1시간, 새 메시지만 |
| `data/messages_now.csv` | ⑨ 지금 걸려 있는 메시지 목록 (현황판의 '걸려 있는 메시지'는 이 파일 기준) | 1시간, 새로 씀 |
| `data/messages_gone/날짜.csv` | ⑨ 해제되어 사라진 메시지 (`last_seen` = 마지막으로 보인 시각) | 사라질 때 |
| `data/hospitals.csv` | ③ 응급의료기관 목록정보 조회 (좌표, 기관 분류) | 하루 1번 |
| `data/hospital_info.csv` | ⑤ 응급의료기관 기본정보 조회 (진료과목, 병상 수) | 하루 1번 |
| `data/runs.csv` | 수집 실행 기록 | 매번 |

수집 지역: 경기도 (`.github/workflows/collect.yml`의 `STAGES`에서 변경, 여러 시도 가능)

하루 호출 수: ①② 각 144회, ⑨ 24회 안팎, ③ 1회, ⑤ 기관 수만큼 (기능별 한도 1,000회)

## 설정

1. 저장소 **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `SERVICE_KEY`
   - Secret: 공공데이터포털 일반 인증키
2. **Actions** 탭에서 `collect` 워크플로를 켜고 `Run workflow`로 한 번 실행해 본다.
3. 10분마다 실행: GitHub 예약 실행(schedule)이 이 저장소에서 시작되지 않아 **cron-job.org**로 호출한다.
   - GitHub Fine-grained token: 저장소 `GoldenTime`만, 권한은 **Actions: Read and write**만
   - cron-job.org: `POST https://api.github.com/repos/hyun19393/GoldenTime/actions/workflows/collect.yml/dispatches`, 10분마다
   - Headers: `Accept: application/vnd.github+json`, `Authorization: Bearer <토큰>`, `X-GitHub-Api-Version: 2022-11-28`, `Content-Type: application/json`
   - Body: `{"ref":"main"}` (성공 응답: 204)
   - 토큰 만료일이 지나면 수집이 멈추므로 만료 전에 새 토큰으로 바꾼다.

인증키는 코드나 화면 캡처에 남기지 않는다.

## 한계

- 전문의 부재처럼 공공데이터에 없는 거절 사유는 반영하지 않는다.
- 병상 정보는 병원이 입력하는 값이라 실제와 다를 수 있다.
- 거절당한 병원에서 다시 출발하기까지의 시간(확인 지연)은 데이터가 없어 가정값 3분을 쓴다.
- 여러 병원이 동시에 붐비는 경우(거절이 서로 연관된 경우)는 계산에서 독립으로 가정하고, 과거 기록 재현으로 따로 검증한다.
