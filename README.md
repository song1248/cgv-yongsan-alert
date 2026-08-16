# CGV 용산 예매 알림

CGV 용산아이파크몰(`0013`) 시간표를 5분마다 확인해서 원하는 영화의 새 회차, 매진 회차 재오픈, 잔여석 증가를 GitHub Issue로 알립니다.

가까운 7일은 매 실행마다 확인하고, 8~14일 범위는 공개 API 호출 제한을 피하기 위해 12회마다 한 번, 즉 약 1시간마다 확인합니다.

## 설정

1. `watch-config.json`의 `targets`를 수정합니다.
2. GitHub 저장소를 만들고 이 프로젝트를 push합니다.
3. 저장소의 **Actions** 탭에서 workflow를 활성화합니다.
4. 이메일을 받으려면 저장소를 Watch하거나 GitHub 알림 이메일 설정을 켭니다.
5. 이슈 label을 쓰고 싶으면 GitHub 저장소에 label을 먼저 만든 뒤 `notification.githubIssue.labels`에 추가합니다.

예시:

```json
{
  "id": "wanted-movie",
  "name": "원하는 영화",
  "enabled": true,
  "movieNameIncludes": ["스파이더맨"],
  "screenProfile": "yongsan-imax",
  "minRemainingSeats": 1,
  "notifyOn": {
    "newDate": true,
    "newShowtime": true,
    "seatReopened": true,
    "seatIncrease": true
  }
}
```

현재 공개 API 응답은 상영관명을 주지 않는 경우가 있어 용산 IMAX는 `screenProfiles.yongsan-imax.totalSeatsIn: [624]`로 식별합니다. 나중에 데이터 소스가 상영관명/상영타입을 제공하면 `screenNameIncludes`가 먼저 적용됩니다.

## GitHub 토큰

GitHub Actions 안에서는 기본 `GITHUB_TOKEN`을 사용하므로 별도 토큰이 없어도 Issue 생성과 상태 커밋이 가능합니다. 새 원격 저장소를 CLI로 만들거나 로컬에서 직접 알림을 테스트하려면 `.env`에 `GITHUB_TOKEN`을 넣으면 됩니다.

```bash
cp .env.example .env
npm run watch
```

## 알림 조건

- `newDate`: 이전에 없던 예매 가능 날짜가 생김
- `newShowtime`: 원하는 영화의 새 예매 가능 회차가 생김
- `seatReopened`: 잔여석이 `0`에서 `1 이상`으로 바뀜
- `seatIncrease`: 잔여석이 이전보다 증가함

첫 실행은 기존 시간표를 모두 알리지 않고 `data/state.json`만 초기화합니다. 새 target을 처음 활성화했을 때도 기존 회차는 초기 상태로만 저장하고, 이후 변화부터 알립니다.

기본 설정은 알림 폭주를 줄이기 위해 잔여석 증가 중에서도 `0 -> 1 이상`으로 바뀐 경우만 알립니다. 일반적인 `3석 -> 4석` 같은 증가까지 받고 싶으면 `behavior.notifySeatIncreaseFromSoldOutOnly`를 `false`로 바꾸면 됩니다.

## 테스트 알림

GitHub Actions에서 **CGV Watch** workflow를 수동 실행할 때 `testNotification`을 `true`로 선택하면 실제 변화가 없어도 테스트 Issue를 하나 생성합니다.

감시 조건이나 조회 범위를 바꾼 직후 기존 회차를 기준값으로만 저장하고 싶으면 수동 실행에서 `baselineOnly`를 `true`로 선택합니다. 이 모드는 14일 전체를 조회하지만 알림 Issue는 만들지 않습니다.

## 환경 변수

로컬에서 실행할 때는 `.env.example`을 복사해서 `.env`를 만듭니다. `.env`는 토큰과 이메일 주소가 들어가므로 커밋하지 않습니다.

```bash
cp .env.example .env
```

GitHub Actions에서 실행할 때는 저장소의 **Settings > Secrets and variables > Actions**에 같은 이름으로 등록합니다. `RESEND_API_KEY`는 가능하면 Secret에 넣고, 노출되어도 괜찮은 값만 Variables에 넣는 것을 권장합니다. 현재 workflow는 `secrets.*`가 없으면 `vars.*`를 읽도록 되어 있습니다.

## 이메일 알림

Resend를 사용하려면 `.env` 또는 GitHub Actions Secrets/Variables에 아래 값을 등록합니다.

```text
RESEND_API_KEY=re_...
EMAIL_FROM=CGV Alert <noreply@your-verified-domain.com>
EMAIL_RECIPIENTS=user1@example.com,user2@example.com
```

수신자는 쉼표로 구분합니다. 메일 주소 노출을 피하기 위해 수신자별로 한 통씩 따로 보냅니다.

여러 명에게 보내려면 `EMAIL_FROM`의 도메인이 Resend에서 verified 상태여야 합니다. 검증되지 않은 도메인을 쓰면 GitHub Issue 알림은 생성되지만 이메일은 Resend 403 오류로 건너뜁니다.
