# NUVIO Host Center plugin

NUVIO의 사전 등록된 Remote MCP connection을 사용하는 read-only plugin입니다.

## 설치

ChatGPT Desktop 또는 Codex가 설치된 PC의 터미널에서 다음 명령을 순서대로 실행합니다.

```text
codex plugin marketplace add bananaggong/nuvio-plugins --ref main --sparse .agents/plugins --sparse plugins/nuvio-host-center
codex plugin add nuvio-host-center@nuvio
```

ChatGPT Desktop을 다시 시작한 뒤 Plugins에서 `NUVIO Host Center`를 활성화합니다. 최초 설치 또는 사용 시 NUVIO 로그인 화면에서 연결할 호스트센터와 read-only 권한을 승인합니다.

사용자는 OAuth `client_id`, client secret, access token 또는 DB 자격 증명을 입력하지 않습니다. OAuth client 설정은 `.app.json`이 참조하는 사전 등록 connection에서 관리합니다.

## 현재 범위

- `host_centers.list`
- `programs.list`
- `programs.get`
- `programs.validate`

초안 저장, 공개, 보관, 삭제, 신청자 개인정보, 메시지, 결제·환불은 포함하지 않습니다.
