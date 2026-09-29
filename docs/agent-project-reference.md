# エージェント向けプロジェクト参照

Claude Code / Codex / omp (oh-my-pi) 対応モバイルクライアント

## プロジェクト構成

```
ccpocket/
├── packages/bridge/    # Bridge Server (TypeScript, WebSocket)
│   └── src/
│       ├── index.ts           # エントリーポイント
│       ├── websocket.ts       # WebSocket接続管理・マルチセッション
│       ├── session.ts         # セッション管理 (SessionManager)
│       ├── claude-process.ts  # Claude CLIプロセス管理 (SDK経由)
│       ├── codex-process.ts   # Codex CLIプロセス管理 (SDK経由)
│       ├── omp-process.ts     # omp プロセス管理 (`omp --mode rpc-ui`, RPC v2)
│       ├── omp-*.ts           # omp の転送・ツール変換・セッションストア・履歴・writer 登録
│       └── parser.ts          # stream-json パース・型定義
├── apps/mobile/        # Flutter Mobile App
│   └── lib/
│       ├── main.dart
│       ├── features/                      # Feature-first ディレクトリ
│       │   ├── chat_session/              # 共通チャットセッション (state/widgets)
│       │   ├── claude_session/            # Claude Code セッション画面
│       │   ├── codex_session/             # Codex セッション画面
│       │   ├── omp_session/               # omp セッション画面
│       │   ├── session_list/              # セッション一覧 (ホーム)
│       │   ├── connection/                # 接続・マシン管理
│       │   ├── diff/                      # Diff表示画面
│       │   ├── gallery/                   # ギャラリー画面
│       │   ├── message_images/            # メッセージ画像ビューア
│       │   ├── prompt_history/            # プロンプト履歴
│       │   ├── settings/                  # 設定画面
│       │   ├── setup_guide/               # 初回セットアップガイド
│       │   └── debug/                     # デバッグ画面
│       ├── models/messages.dart           # メッセージ型定義
│       ├── providers/                     # グローバルprovider
│       ├── services/bridge_service.dart   # WebSocketクライアント
│       ├── utils/diff_parser.dart         # Unified diffパーサー
│       └── widgets/                       # 共有Widget
└── package.json        # npm workspaces root
```

## コマンド

### Bridge Server
```bash
npm run bridge          # 開発サーバー起動 (tsx)
npm run bridge:build    # TypeScriptビルド
```

### Flutter App
```bash
cd apps/mobile && flutter run    # アプリ起動
cd apps/mobile && flutter test   # テスト実行
```

### 開発用一括再起動
```bash
npm run dev                      # Bridge再起動 + Flutterアプリ起動
npm run dev -- <device-id>       # デバイス指定付き
```

Bridge Serverの停止→再起動とFlutterアプリの起動を一括で行う。
Flutterアプリ終了時にBridge Serverも自動停止する。
スクリプト本体: `scripts/dev-restart.sh`

## 技術スタック

- **Bridge Server**: TypeScript, WebSocket (ws), Node.js
- **Mobile App**: Flutter/Dart, shared_preferences
- **パッケージ管理**: npm workspaces

## Bridge Server アーキテクチャ

```
                                         ┌→ claude-process.ts ←SDK→ Claude Code CLI
Flutter App ←WebSocket→ websocket.ts ←→ session.ts ─┼→ codex-process.ts ←SDK→ Codex CLI
                                              ↕      └→ omp-process.ts ←stdio RPC v2→ omp --mode rpc-ui
                                          parser.ts
```

- `parser.ts` - Claude CLI stream-json出力のパースと型定義 (stream_event含む)
- `claude-process.ts` - Claude Code CLIプロセス管理 (Claude Agent SDK経由)
- `codex-process.ts` - Codex CLIプロセス管理 (Codex SDK経由)
- `omp-process.ts` - omp セッション管理。`omp --mode rpc-ui` を1 Bridgeセッションにつき1プロセス起動し、omp のフレームを `ServerMessage` に変換する
- `omp-rpc-transport.ts` / `omp-tool-mapping.ts` / `omp-env.ts` - omp の起動・フレーミング・v2 ネゴシエーション、ツール名/入力の変換、環境変数とストアの解決
- `omp-sessions.ts` / `omp-history.ts` / `omp-writers.ts` / `omp-print.ts` - omp のセッションストア一覧・履歴変換・1ファイル1 writer の登録・`omp -p` アシスト
- 設計と互換性方針: `docs/omp-integration.md`、プロトコル capability: `docs/protocol-versioning.md`
- `session.ts` - マルチセッション管理 (SessionManager)
- `websocket.ts` - WebSocket接続管理・認証・メッセージルーティング
- `http-handler.ts` / `request-auth.ts` - HTTPルーティングとAPIキー判定 (WebSocket と共通)
- `index.ts` - エントリーポイント

## 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `BRIDGE_PORT` | `8765` | WebSocketポート |
| `BRIDGE_HOST` | `0.0.0.0` | バインドアドレス |
| `BRIDGE_API_KEY` | (なし) | 設定時は WebSocket と全HTTPエンドポイントでAPIキーを要求 (下記「Bridge の認証とHTTPエンドポイント」) |
| `BRIDGE_ALLOWED_DIRS` | `$HOME` | 許可するプロジェクトディレクトリ (カンマ区切り) |
| `BRIDGE_RECORDING` | (なし) | セッション録画を有効化 (設定時に有効化) |
| `BRIDGE_DISABLE_MDNS` | (なし) | mDNSアドバタイズメントを無効化 (設定時に有効化) |
| `DIFF_IMAGE_AUTO_DISPLAY_KB` | `1024` (1MB) | Diff画像の自動表示閾値 (KB単位) |
| `DIFF_IMAGE_MAX_SIZE_MB` | `5` (5MB) | Diff画像の最大サイズ (MB単位、超過はテキストのみ) |
| `HTTPS_PROXY` | (なし) | プロキシ設定 (`http://`, `socks5://` 対応) |
| `BRIDGE_OMP_BIN` | `omp` (PATH) | omp CLI のパス |
| `BRIDGE_OMP_ASSIST_MODEL` | セッションのモデル | omp の自動 Rename / コミットメッセージ生成に使うモデル (`<provider>/<id>`) |
| `OMP_PROFILE` / `PI_PROFILE` / `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` | omp の既定 | omp のプロファイルとセッションストア。Bridge は omp と同じ規則で解決する |

### プッシュ通知 (FCM)

Bridge起動時にFirebase Anonymous Authで自動認証される。環境変数の設定は不要。
Cloud Functions (relay) がFCMトークンの管理とプッシュ送信を担当する。

## WebSocket プロトコル

### Client → Server メッセージ
- `client_capabilities` - プロトコル範囲、opt-in メッセージ、`supportedProviders` (omp を表示できるクライアントは `omp` を含める)
- `start` - 新規セッション開始 (projectPath, provider?, sessionId?, continue?, permissionMode?, omp: model?, thinkingLevel?, executionMode?)
- `resume_session` - 過去セッション再開 (provider `omp` は model / thinkingLevel を検証し、未知の値は落とす)
- `set_omp_model` - omp セッションのモデル / thinking level 変更 (sessionId, model?, thinkingLevel?)
- `list_recent_sessions` - 最近のセッション (provider? または providers[])
- `input` - ユーザーメッセージ送信 (text, sessionId?)
- `approve` - ツール実行承認 (id, sessionId?)
- `reject` - ツール実行拒否 (id, message?, sessionId?)
- `answer` - AskUserQuestion応答 (toolUseId, result, sessionId?)
- `list_sessions` - セッション一覧取得
- `stop_session` - セッション停止 (sessionId)
- `get_history` - セッション履歴取得 (sessionId)
- `get_diff` - プロジェクトのgit diff取得 (projectPath)
- `list_directory` - 許可ルート配下のディレクトリ一覧取得 (path, requestId?)

### Server → Client メッセージ
- `system` - システムイベント (init, session_created, omp_settings: omp のモデル・thinking level のスナップショット)
- `assistant` - エージェントの応答メッセージ (Claude Code / Codex)
- `tool_result` - ツール実行結果
- `result` - 最終結果 (コスト・所要時間含む)
- `error` - エラー通知
- `status` - プロセスステータス (idle/running/waiting_approval)
- `history` - メッセージ履歴
- `permission_request` - パーミッション要求
- `stream_delta` - ストリーミングテキスト差分
- `session_list` - セッション一覧 (`protocolCapabilities`、omp を宣言したクライアントには `ompModels` / `ompAvailability` / `ompModelsRevision`)
- `diff_result` - git diff結果 (diff, error?)
- `directory_listing` - ディレクトリ一覧結果 (path, directories, requestId?)

### Bridge 非対応メッセージの Graceful Degradation

アプリが新しいメッセージタイプを送り、古い Bridge が認識できない場合の処理基盤。

- **Bridge 側**: `errorCode: "unsupported_message"` + 元のタイプ名を返す (`websocket.ts`)
- **App 側**: `chat_message_handler.dart` の `_unsupportedActions` マップでタイプ別に振る舞いを制御
  - `suppress` (デフォルト) — ログのみ、UIに表示しない (バックグラウンド機能向け)
  - `showUpdateHint` — amber warning バブルで Bridge 更新を案内 (ユーザー操作向け)
- 通常のチャット操作は、新機能追加時に `_unsupportedActions` へ1行追加する
- 専用UIが直接レスポンスを待つ操作（例: `list_directory`）は、そのUI内で
  `unsupported_message` と元のタイプ名を照合し、Bridge更新案内を表示する

## Bridge の認証とHTTPエンドポイント

実装は `packages/bridge/src/request-auth.ts` (判定) と `http-handler.ts` (HTTPルーティング)。WebSocket も同じ判定関数を使う。

- `BRIDGE_API_KEY` 設定時は、WebSocket と全HTTPエンドポイント (`/version`, `/usage`, `/doctor`, `/images/*`, `/api/media/*`, `/api/uploads/*`, `/api/gallery*`, 未知のパス) でキーを要求する。受け付けるのは `?token=<key>` と `Authorization: Bearer <key>`。比較は SHA-256 ダイジェスト同士の定数時間比較。
- 拒否時: HTTP は `401` + `{"error":"Unauthorized"}` + `WWW-Authenticate: Bearer realm="ccpocket"`。WebSocket は従来どおり接続後に `4001` で close する。
- 例外は `OPTIONS` プリフライトと `GET /health`。アプリはキーを付けられない場面でも `/health` を呼ぶため、キーなしで答える。到達性プローブ (`bridge_endpoint_probe.dart`) は HTTPS のときだけ `Authorization: Bearer` を付け、平文HTTPでは付けない。`machine_manager_service.dart` と `BridgeService.checkHealth` は、自動モードで暗号化されていない接続 (SSLなし、SSHジャンプなし) ではユーザーの確認までキーを付けず、それ以外 (HTTPS、明示的な `ws://`、SSHトンネル) では付ける。キーが未登録の場合もある。どの呼び出しも HTTP 200 と `status == "ok"` だけを見る。未認証では `{"status":"ok"}` だけを返し、キー付きの場合のみ `uptime` / `sessions` / `clients` を追加する。
- `BRIDGE_API_KEY` 未設定時の挙動は変えない (全エンドポイントが認証なし、`/health` も従来の全項目)。
- ルーティングは `req.url` の完全一致ではなく pathname で行う。`?token=` 付きでも同じルートに届く。
- 互換性: キー設定時、HTTPリクエストにキーを付けない古いアプリでは画像・メディア・ファイル転送・ギャラリー・`/version` が `401` になる。Bridge と同時にアプリを更新する。WebSocket は従来の `?token=` をそのまま受け付ける。
- localhost は信頼境界ではない (同じホストの他ユーザーやコンテナから 127.0.0.1 に届く)。SSHトンネルや VPN 経由でもキーを設定する。

認証と無関係に適用する防御:

- URLとして解釈できないリクエストターゲット (例: `//[`) は `400`。`Host` ヘッダーはURL解析に使わない (以前は不正な `Host` で WebSocket upgrade が例外を投げ、プロセスが落ちた)。プロセス全体の `uncaughtException` ハンドラーは既存パターンにないため追加していない。
- `POST /api/gallery/upload` の `filePath` モードは、symlink 解決後のパスが `BRIDGE_ALLOWED_DIRS` 内の場合だけコピーし、それ以外は `403`。ボディ上限は `GALLERY_UPLOAD_MAX_BODY_BYTES` (ImageStore の上限 10MB の base64 長 + 64KiB)。`Content-Length` で超過が分かれば読まずに、チャンク転送では超過した時点で `413` を返し接続を閉じる。
- WebSocket keepalive: Bridge は 30 秒ごとに全クライアントへ ping を送る。生存の証拠は、受信データ (pong に限らず、大きなメッセージの途中も含む) と、前回の tick で送信待ちだったデータの書き込み完了。2 tick 続けて証拠がないクライアントを terminate する (切れた経路の検知は 60〜90 秒)。低速回線では ping や pong が大きなメッセージの後ろで待ち、送信済みのデータもカーネルや SSH トンネルのバッファで数十秒待つため、1 tick の無応答は許容する。Node は書き込み完了を write 単位 (送信待ちの複数フレームはまとめて1回) でしか通知しないため、1回の書き込みの転送に約 60 秒以上かかり、その間クライアントが何も送らない場合は切断される。dart:io・ブラウザ・`ws` は ping に自動で pong を返すため、クライアント側の変更は不要。

## リモートアクセス設定

### Tailscale経由
1. Mac・iPhoneの両方にTailscaleをインストール
2. Bridge Serverを起動 (`BRIDGE_HOST=0.0.0.0`)
3. Flutter AppのServer URLに `ws://<Mac_Tailscale_IP>:8765` を入力

### launchd永続化

plistテンプレートは `zsh -li -c "exec node ..."` でBridge Serverを起動する。
ログイン+インタラクティブシェル経由で起動することで、Terminal.appと同じ環境
（nvm, pyenv, Homebrew等の初期化を含む）が反映される。
`exec` によりzshプロセスはnodeに置き換わるため、余分なプロセスは残らない。

```bash
# 1. テンプレートを編集
cp packages/bridge/com.ccpocket.bridge.plist ~/Library/LaunchAgents/
# パスとAPIキーを実際の値に更新

# 2. ビルド
npm run bridge:build

# 3. サービス登録
launchctl load ~/Library/LaunchAgents/com.ccpocket.bridge.plist

# 4. 確認
launchctl list | grep ccpocket

# アンロード
launchctl unload ~/Library/LaunchAgents/com.ccpocket.bridge.plist
```

## MCP ツール使い分け

### 原則: DTD/VM Service接続が必要 = MCP、それ以外 = CLI

| 操作 | 推奨 | ツール |
|------|------|--------|
| アプリ起動 | **MCP** | dart-mcp `launch_app` |
| アプリ停止 | **MCP** | dart-mcp `stop_app` |
| ホットリロード | **MCP** | dart-mcp `hot_reload` |
| ランタイムエラー | **MCP** | dart-mcp `get_runtime_errors` |
| ウィジェットツリー | **MCP** | dart-mcp `get_widget_tree` |
| UI要素一覧 | **MCP** | marionette `get_interactive_elements` |
| UI操作 | **MCP** | marionette `tap` / `enter_text` / `scroll_to` / `double_tap` / `long_press` / `swipe` / `pinch_zoom` / `press_back_button` |
| デバイス一覧 | CLI | `flutter devices` |
| 静的解析 | CLI | `dart analyze apps/mobile` |
| フォーマット | CLI | `dart format apps/mobile` |
| テスト | CLI | `cd apps/mobile && flutter test` |
| 依存関係 | CLI | `cd apps/mobile && flutter pub get` |

詳細は `/mobile-automation` スキルを参照。


環境設定・プロトコル・ランタイム操作が必要な場合に参照する。コマンドはリポジトリルート基準。
