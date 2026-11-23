# Pattern Seeker 개발 원칙 (사람·AI 에이전트 공통)

## 범위
- 이 저장소는 Pattern Seeker 하나만 다룹니다. CatalystFlow MES 등 다른 앱과 기능·데이터를 섞지 않습니다.
- 기존 기능과 데이터를 보존하면서 작은 단위로 개선합니다. 전면 재작성은 하지 않습니다.

## 실행과 구조
- 서버는 Python 표준 라이브러리만 씁니다(`app/server.py`). DB는 SQLite(`app/db.py`)입니다. 화면은 의존성 없는 바닐라 JS(`app/static/`)입니다.
- 오프라인 Windows 사용이 기본입니다. 외부 CDN, 빌드 도구, 필수 pip 패키지를 추가하지 않습니다. 선택 기능(pypdf, OCR)은 없어도 앱이 동작해야 합니다.
- 화면 파일의 역할:

  | 파일 | 역할 |
  |---|---|
  | `calc.js` | 계산·파싱. 순수 함수이며 식 문자열을 함께 제공 |
  | `chart.js` | SVG 그래프 |
  | `app.js` | API, 모달, 저장 바, 라우터 |
  | `tools.js` | 측정 편집기와 분석별 도구 |
  | `views.js` | 화면 |

## 데이터 보존 규칙
1. 스키마 변경은 `app/migrations/NNN_*.sql` 새 파일과 `db.MIGRATIONS` 항목으로만 합니다. 기존 마이그레이션 파일은 고치지 않습니다.
2. 마이그레이션은 `db.migrate()`가 다음 순서로 실행합니다. 이 순서를 우회하지 마세요.
   1. 사본에 적용해 무결성을 검사하고 행 수가 줄지 않았는지 확인합니다.
   2. 원본을 백업하고 그 백업을 검증합니다.
   3. 원본에 적용합니다.
3. 데이터를 지우지 않습니다. 샘플과 측정은 소프트 삭제(휴지통)합니다. 수정·삭제 전 상태는 `audit_log`에 남깁니다.
4. 첨부 원본 파일과 `data/files`의 복사본은 앱이 삭제하지 않습니다. 첨부를 삭제해도 연결 정보만 지웁니다.
5. 측정되지 않은 값은 키를 두지 않거나 `null`로 둡니다. 0이나 “정상”으로 채우지 않습니다.

## 값의 출처 구분
- 조건이나 값에는 `source`를 붙입니다.

  | source | 뜻 |
  |---|---|
  | `default` | 앱 기본값, 미확인 |
  | `user` | 사용자 입력 또는 확인 |
  | `file` | 파일에 기재된 값 자동 입력 |
  | `extracted` | 추출한 값 |
  | `extracted_edited` | 추출 후 사용자가 수정한 값 |
  | `fit` | 앱의 Gaussian 피팅이 추정한 값 (실측 아님) |

- `measurements`의 칸 구분:
  - `values`: 보고서·입력·추출 값
  - `computed`: 앱 계산값. `metrics.{key}.formula`와 `inputs`를 함께 저장합니다.
  - `conditions`: 측정 조건
  - `source`: 출처
- 연구자 해석과 AI 가설은 `interpretations.kind`로 구분합니다. AI 가설을 사실처럼 표시하지 않습니다.
- 측정일 출처는 `measured_on_source`에 기록합니다(`user` > `file` > `none`). 사용자가 고른 날짜가 항상 우선합니다.

## 분석 종류 확장
- 분석 종류는 `analysis_types` 테이블의 데이터로 정의합니다(`config.fields`, `config.metrics`, `config.default_conditions`, `config.tool`).
- 전용 도구가 없으면 generic 입력 화면을 씁니다. 비교와 패턴 탐색은 `metrics` 정의만 보고 동작합니다.

## 계산 기준 (사용자가 정한 것: 바꾸려면 사용자 확인 필요)
- XRD GS: `0.94 × 0.15418 / (radians(FWHM) × cos(radians(2θ/2)))` nm. K와 λ는 측정 조건 값을 씁니다.
- XRD SI: `적분 면적 / FWHM`. 정수로 표시합니다.
- BET 기본 선택 구간: R² ≥ 0.995, C > 0, Rouquerol 기준 1·3을 모두 만족하는 후보 중 R² 최고. 점 개수로는 고르지 않습니다. 후보가 없으면 계산하지 않습니다.
- PSA: Span = (D90 − D10)/D50. D90 10–25 µm은 참고 범위일 뿐 합격 기준이 아닙니다.
- TGA 수분: [m(T1) − m(T2)] / m₀ × 100. 구간 근거 입력이 필수입니다.
- Cdl: (i_a − i_c)/2 대 scan rate(V/s)의 기울기(mF). ECSA = Cdl/Cs이며 추정값으로 표시합니다. BET 직접 측정값이 아닙니다.
- XRD 피팅: Gaussian(기본 7개), Levenberg–Marquardt. 원본 XY는 바꾸지 않고 결과는 `datasets.meta.fit`에 저장합니다. 피크 표로 가져온 행은 `source='fit'`입니다.
- BET 예측: 실측 BET ↔ Cdl/로딩 선형 보정. 학습 샘플 5개 미만이면 예측값을 표시하지 않습니다. LOO 오차, 학습 범위, 95 % 예측구간을 함께 표시하고, 범위 밖은 외삽으로 경고합니다. 예측값은 저장하지 않습니다.
- 표시는 기본 소수점 둘째 자리로 하고, 원본 정밀도는 그대로 저장합니다.

## 검증
- 사용자가 요청하지 않은 테스트 파일을 저장소에 추가하지 않습니다. 변경을 확인할 때는 임시 데이터 폴더(`PATTERN_SEEKER_DATA`)로 서버를 띄워 확인하고, 무엇을 확인했는지 보고합니다.
- 실제 운영 DB로 실험하지 않습니다. 마이그레이션은 운영 DB의 사본으로 먼저 검증합니다.
