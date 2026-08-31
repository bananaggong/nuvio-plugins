# NUVIO plugins

NUVIO의 ChatGPT·Codex용 plugin distribution repository입니다.

이 저장소에는 서비스 소스 코드나 데이터베이스 자격 증명이 포함되지 않습니다. `NUVIO Host Center` plugin은 사전 등록된 NUVIO Remote MCP connection을 참조하고, 사용자는 NUVIO 로그인 후 자신이 접근할 수 있는 호스트센터와 역할에 허용된 권한만 승인합니다. plugin은 자연어 요청을 프로그램 조회, 초안 생성·수정, 공개 준비 검사와 NUVIO 승인 기반 공개·보관 흐름으로 연결합니다.

## 설치

```text
codex plugin marketplace add bananaggong/nuvio-plugins --ref main --sparse .agents/plugins --sparse plugins/nuvio-host-center
codex plugin add nuvio-host-center@nuvio
```

자세한 범위와 사용법은 [`plugins/nuvio-host-center/README.md`](plugins/nuvio-host-center/README.md)를 확인하세요.
