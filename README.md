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
  "minRemainingSeats": 1,
  "notifyOn": {
    "newDate": true,
    "newShowtime": true,
    "seatReopened": true,
    "seatIncrease": true
  }
}
```

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

## 테스트 알림

GitHub Actions에서 **CGV Watch** workflow를 수동 실행할 때 `testNotification`을 `true`로 선택하면 실제 변화가 없어도 테스트 Issue를 하나 생성합니다.
