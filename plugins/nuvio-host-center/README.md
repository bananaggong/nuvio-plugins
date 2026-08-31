# NUVIO Host Center plugin

NUVIO의 사전 등록된 Remote MCP connection을 사용해 호스트센터 프로그램을 자연어로 운영하는 plugin입니다.

## 설치

ChatGPT Desktop 또는 Codex가 설치된 PC의 터미널에서 다음 명령을 순서대로 실행합니다.

```text
codex plugin marketplace add bananaggong/nuvio-plugins --ref main --sparse .agents/plugins --sparse plugins/nuvio-host-center
codex plugin add nuvio-host-center@nuvio
```

ChatGPT Desktop을 다시 시작한 뒤 Plugins에서 `NUVIO Host Center`를 활성화합니다. 최초 설치 또는 사용 시 NUVIO 로그인 화면에서 연결할 호스트센터와 현재 역할에 허용된 권한을 승인합니다.

사용자는 OAuth `client_id`, client secret, access token 또는 DB 자격 증명을 입력하지 않습니다. OAuth client 설정은 `.app.json`이 참조하는 사전 등록 connection에서 관리합니다.

## 기존 설치 업데이트

자연어 운영 skill 같은 plugin package 변경을 받으려면 아래 명령을 한 줄씩 실행한 뒤 앱을 완전히 종료하고 다시 시작하여 새 대화를 엽니다.

```text
codex plugin marketplace upgrade nuvio
codex plugin add nuvio-host-center@nuvio
```

서버의 MCP tool만 추가된 경우에는 보통 plugin 재설치가 필요 없지만, 새 쓰기 scope가 필요한 기존 read-only 연결은 NUVIO 연결 관리에서 철회 후 재연결해야 할 수 있습니다.

## 자연어로 할 수 있는 일

- `host_centers.list`
- `programs.list`
- `programs.get`
- `programs.validate`
- `programs.create_draft`
- `programs.update_draft`
- `programs.prepare_publish` → `nuvio.kr` 승인 → `programs.publish`
- `programs.prepare_archive` → `nuvio.kr` 승인 → `programs.archive`

실제 표시되는 도구는 사용자의 센터 membership role, OAuth grant scope, NUVIO의 단계별 rollout 상태에 따라 달라집니다. 기존 read-only 연결에는 쓰기 scope가 자동 추가되지 않으므로, NUVIO에서 쓰기 베타가 활성화된 뒤 연결을 철회하고 다시 연결해 새 권한에 동의해야 할 수 있습니다.

예를 들어 “보성 센터에 10월 10일부터 2박 3일 프로그램 초안을 만들어줘”, “이 프로그램의 참가비만 3만원으로 바꾸고 공개 준비 상태를 확인해줘”, “공개할 변경사항을 보여주고 승인 화면으로 안내해줘”처럼 요청할 수 있습니다.

신청자 개인정보 조회·내보내기, 대량 메시지 발송, 결제·환불 실행, hard delete, 임의 URL fetch·webhook·email 전송은 현재 포함하지 않습니다. 공개와 보관은 AI 화면의 확인만으로 실행되지 않으며 NUVIO의 신뢰된 승인 화면을 반드시 거칩니다.
