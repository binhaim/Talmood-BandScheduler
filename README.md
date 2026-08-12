# Talmood BandScheduler

탈무드 밴드 프로젝트와 합주 일정을 관리하는 웹 앱입니다.

- 서비스: https://binhaim.github.io/Talmood-BandScheduler/
- 데이터: Firebase Realtime Database
- 배포: GitHub Pages

## 멤버 캘린더 구독

메인 화면에서 멤버를 선택하면 휴지통에 없는 모든 프로젝트의 해당 멤버 일정을 고정 `.ics` URL로 구독할 수 있습니다. [Pages 배포 워크플로](.github/workflows/deploy-pages.yml)가 약 10분마다 Firebase 데이터를 읽어 구독 파일을 다시 생성합니다. 캘린더 앱의 실제 반영 시점은 서비스별 구독 갱신 주기에 따릅니다.

```sh
npm ci
npm test
npm run generate:feeds -- --output _site/calendars
```
