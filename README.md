# CGV 용산 예매 알림

CGV 용산아이파크몰(`0013`) 시간표를 5분마다 확인해서 원하는 영화의 새 예매 가능 회차를 GitHub Issue와 이메일로 알립니다. 좌석표 데이터 소스가 제공되면 지정 구역의 연속 2좌석 출현도 알립니다.

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
  "desiredAdjacentSeats": {
    "ranges": [
      { "rows": ["H", "I"], "from": 13, "to": 31 },
      { "rows": ["J", "K", "L"], "from": 11, "to": 34 }
    ]
  },
  "notifyOn": {
    "newDate": false,
    "newShowtime": true,
    "seatReopened": false,
    "seatIncrease": false,
    "desiredSeatPair": true
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

- `newShowtime`: 원하는 영화의 새 예매 가능 회차가 생김
- `desiredSeatPair`: 지정한 좌석 범위 안에서 같은 행 연속 2좌석이 새로 가능해짐

첫 실행은 기존 시간표를 모두 알리지 않고 `data/state.json`만 초기화합니다. 새 target을 처음 활성화했을 때도 기존 회차는 초기 상태로만 저장하고, 이후 변화부터 알립니다.

현재 운영 설정은 `newDate`, `seatReopened`, `seatIncrease` 숫자 기반 알림을 끕니다. 매진 회차가 다시 열렸더라도 지정 좌석 연속 2석이 없으면 좌석 알림을 보내지 않습니다.

주의: 현재 `mcp.aka.page` CGV API는 회차별 잔여석 수까지만 제공하고, `H13` 같은 좌석 번호 단위 좌석표는 제공하지 않습니다. `desiredSeatPair` 로직은 좌석표 데이터가 `showtime.seats`로 들어오는 데이터 소스가 연결되면 동작합니다.

## 테스트 알림

GitHub Actions에서 **CGV Watch** workflow를 수동 실행할 때 `testNotification`을 `true`로 선택하면 실제 변화가 없어도 테스트 Issue를 하나 생성합니다.

감시 조건이나 조회 범위를 바꾼 직후 기존 회차를 기준값으로만 저장하고 싶으면 수동 실행에서 `baselineOnly`를 `true`로 선택합니다. 이 모드는 14일 전체를 조회하지만 알림 Issue는 만들지 않습니다.

## 환경 변수

로컬에서 실행할 때는 `.env.example`을 복사해서 `.env`를 만듭니다. `.env`는 토큰과 이메일 주소가 들어가므로 커밋하지 않습니다.

```bash
cp .env.example .env
```

GitHub Actions에서 실행할 때는 저장소의 **Settings > Secrets and variables > Actions**에 등록합니다. `GMAIL_APP_PASSWORD`, `GMAIL_USER`, `RESEND_API_KEY`는 Secret에 넣습니다. Repository Variables는 Actions 로그에 값이 그대로 출력될 수 있어서 비밀번호나 API key에는 쓰면 안 됩니다. `EMAIL_PROVIDER`, `EMAIL_FROM`, `EMAIL_RECIPIENTS`는 Secret 또는 Variables로 등록할 수 있습니다.

## 이메일 알림

Gmail을 사용하려면 `.env` 또는 GitHub Actions 설정에 아래 값을 등록합니다.

```text
EMAIL_PROVIDER=gmail
GMAIL_USER=your@gmail.com
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
EMAIL_FROM=your@gmail.com
EMAIL_RECIPIENTS=user1@example.com,user2@example.com
```

GitHub Actions에서는 `GMAIL_USER`, `GMAIL_APP_PASSWORD`를 Secret으로 등록합니다. `EMAIL_FROM`은 생략하거나 `GMAIL_USER`와 같은 주소로 둡니다. Gmail은 발신 주소를 인증된 Gmail 계정으로 다시 쓸 수 있습니다.

Resend를 사용하려면 아래 값을 등록합니다.

```text
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_...
EMAIL_FROM=CGV Alert <noreply@your-verified-domain.com>
EMAIL_RECIPIENTS=user1@example.com,user2@example.com
```

GitHub Actions에서는 `RESEND_API_KEY`를 Secret으로, `EMAIL_FROM`과 `EMAIL_RECIPIENTS`를 Variables 또는 Secrets로 등록합니다.

수신자는 쉼표로 구분합니다. 메일 주소 노출을 피하기 위해 수신자별로 한 통씩 따로 보냅니다.

여러 명에게 보내려면 `EMAIL_FROM`의 도메인이 Resend에서 verified 상태여야 합니다. 검증되지 않은 도메인을 쓰면 GitHub Issue 알림은 생성되지만 이메일은 Resend 403 오류로 건너뜁니다.

## 카카오톡 알림

KakaoTalk Message API를 추가 알림 채널로 사용할 수 있습니다. 이 기능은 카카오톡 채널 친구 전체 발송이 아니라, Kakao Developers 앱에 연결된 사용자/친구에게 메시지를 보내는 방식입니다.

GitHub Actions에는 아래 값을 등록합니다.

```text
Variables:
KAKAO_ENABLED=true
KAKAO_SEND_TO_ME=false

Secrets:
KAKAO_REST_API_KEY=...
KAKAO_REFRESH_TOKEN=...
KAKAO_RECEIVER_UUIDS=uuid1,uuid2
```

`KAKAO_ACCESS_TOKEN`도 Secret으로 넣을 수 있지만 access token은 만료가 짧으므로, 장기 실행에는 `KAKAO_REFRESH_TOKEN`을 넣고 매 실행마다 access token을 갱신하는 방식을 사용합니다. 앱에 Client secret 사용이 켜져 있으면 `KAKAO_CLIENT_SECRET`도 Secret으로 등록합니다.

친구에게 보내려면 Kakao Developers에서 아래 작업이 필요합니다.

1. Kakao Developers 앱 생성 또는 기존 앱 사용
2. Kakao Login 활성화
3. 동의항목에서 `talk_message` 설정
4. 친구 목록/친구 메시지 권한 신청
5. 수신자들이 해당 앱에 카카오 로그인으로 연결되고 필요한 동의 완료
6. Friends picker 또는 친구 목록 조회 API로 수신자 `uuid` 확보
7. `KAKAO_RECEIVER_UUIDS`에 쉼표로 구분해 등록

한 번에 보낼 수 있는 친구는 최대 5명입니다. 권한 심사 전에는 앱 팀 멤버 대상 테스트만 가능할 수 있습니다.
