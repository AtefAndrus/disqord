# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).



## [1.13.0] - 2026-10-10


### Added

- ピン留め、チャンネル情報、イベントを読む tool を足す (#203)
- Discord のイベントを作る create_event を足す (#204)


### Documentation

- ストリーミング中の分割表示の方針を確定する (#205)
- e2e の既定モデルを Claude Haiku 5.5 にする (#206)
- Claude Haiku 5.5 で通る e2e シナリオを記録する (#207)


## [1.12.0] - 2026-10-08


### Added

- 終了時に生成途中の返信を停止表示にしてから落とす (#202)


### Documentation

- 終了時の進行中返信の後始末の方針を確定する (#201)


## [1.11.1] - 2026-10-08


### Fixed

- 失敗した OpenRouter の応答をログで区別し、定期実行の e2e で失敗理由を返す (#196)
- 返信先の別Bot引用とX展開を修正しE2Eで入力を検証 (#198)


### Documentation

- AGENTS.mdのE2E説明を英語に統一する (#199)
- E2Eの実行案内と検査仕様の参照を整理する (#200)


### Dependencies

- update all non-major dependencies
- update jdx/mise-action action to v5


## [1.11.0] - 2026-10-01


### Added

- 会話の中の投票と締め切りの結果をモデルに渡す (#193)
- 定期実行のジョブで Web 検索を使えるようにする (#195)


### Documentation

- 定期実行での Web 検索の design を追加する (#194)


## [1.10.0] - 2026-09-29


### Added

- 会話履歴の 24 時間の制限をなくし、tool の結果を context 予算で抑える (#176)
- モデルが会話の流れでリアクション、投票、スレッド作成、ピン留めを行えるようにする (#178)
- Discord で表示されない Markdown の表を使わないようモデルに指示する (#182)
- 登録したプロンプトを決まった時刻に実行して投稿する定期実行を追加する (#188)


### Fixed

- 断った設定変更を警告として記録し、preview の Chromium に Windows のフォントを使わせない (#174)
- ルーターのモデルで返答の見出しにフッタと同じモデルを出す (#181)


### Documentation

- 会話履歴の時間制限の撤廃と tool 結果の予算化の設計を追加する (#175)
- 会話履歴の時間制限の撤廃の前後の計測を記録する (#177)
- bot の招待に必要な権限を README に書く (#179)
- e2e の既定モデルを gemini-3.8-flash にし、Discord 操作に要る権限を書く (#180)
- 投票の読み取り、Discord の情報を読む tool、自動応答の返答判定の design を追加する (#183)
- 数式を画像で表示する design を追加する (#184)
- 数式を画像で表示する design の描画、読み戻し、編集の規則を直す (#186)
- 定期実行の design を設定パネルと client tool の作りに合わせて書き直す (#187)
- 会話の区切りの design を追加する (#190)
- 定期実行と Discord 操作ツールの手動確認の結果を design に書く (#192)


### Testing

- cron シナリオのテストで一時 DB の fsync を止めてタイムアウトを防ぐ (#189)


## [1.9.0] - 2026-09-25


### Added

- /config を設定パネルにし、許可チャンネルと管理ロールを設定できるようにする (#169)
- 新しい版で起動したら、設定したチャンネルへ変更点を通知する (#170)
- 設定パネルのチャンネル一覧を 1 つの選択欄で編集できるようにする (#172)


### Fixed

- 設定パネルの on/off ボタンを「有効にする」「無効にする」だけにし、状態で色を分ける (#171)


### Documentation

- 設定パネルの手動確認を完了にする (#173)


### Testing

- e2e の失敗時に返信を保存し、separator を名前指定のシナリオにする (#168)


## [1.8.0] - 2026-09-25


### Added

- ギルド設定のすべての変更に共通の認可を掛ける (#165)
- /release-note で版ごとの変更点を表示する (#166)


### Documentation

- リリースの手動確認の確認対象を in-progress の design に限る (#162)
- design を現在の実装と外部 API に合わせて最新化し、統廃合する (#163)
- /config を設定パネルにする design を起こし、関連 design を合わせる (#164)
- /release-note の手動確認を完了にする (#167)


### Testing

- e2e の画像と長文のシナリオを偶然では通らない形にする (#161)


## [1.7.0] - 2026-09-24


### Added

- Web 検索の有無にかかわらず現在日時をモデルに渡す (#157)


### Fixed

- 現在日時が実際の日時であることをモデルに明示する (#156)
- Web 検索が無効でも過去の画像を開いた後の応答が失敗しないようにする (#158)


### Documentation

- e2e のモデル別の観測をシナリオの横へ移す (#155)
- e2e のギルド設定を DB で切り替えられることを書く (#159)


## [1.6.0] - 2026-09-23


### Added

- ギルド単位で有効にできる Web 検索を追加する (#129)
- Web 検索の上限を 1 リクエスト 4 回に上げる (#131)
- X のポストの URL を fxtwitter で展開してモデルに渡す (#135)
- 会話履歴を保存してモデルの文脈に使う (#136)
- 会話履歴を Discord から読み、窓の外は tool で取りに行く (#140)
- コマンドの返信を Components V2 にし、/status で設定を切り替えられるようにする (#149)
- モデルの推論を受け取り、送り返し、設定に応じて回答の上に表示する (#150)
- /status の各項目を項目名と値の 2 行で表示する (#151)
- 回答の区切り線を Separator で描く (#152)


### Fixed

- 1 ページに収まる返信を最後の行だけ次のページに分けない (#128)
- 回答フッターの所要時間を Latency ではなく Time と秒で表示する (#130)
- 同時に走ったギルド設定の変更が互いを消さないようにする (#132)
- ツイート展開と会話履歴の設定の注意書きを Discord 上から削る (#137)
- 会話履歴で過去の添付を送り直さず表記にする (#138)
- 最終ターンの tool 呼び出しに本文が付いていれば、その本文で答える (#142)
- Web 検索が失敗したら検索なしで答え直す (#153)


### Documentation

- リリースで削除した design へのリンク切れを直し、以後も切れないようにする (#123)
- renovate-pr に lock の年齢の確認と手元での lookup の手順を足す (#127)
- テストが手元の .env を読むことと、design の無い変更の手動確認の置き場所を書く (#133)
- 会話履歴の design を初回リリースの範囲に絞り、削除同期の強化を分ける (#134)
- 会話履歴を Discord から読み、それより前は tool で取りに行く design に書き直す (#139)
- 暗黙の prompt cache の実測結果を design に記録する (#141)
- 過去の画像を開く e2e を change として起こす (#143)
- Gotchas に OpenRouter のモデル選択の手順を足す (#144)
- 重複する design を削除し、ツール系の design を現行の仕様に合わせて書き直す (#146)
- カスタム絵文字・スタンプ・GIF への対応の design を起こす (#147)
- リリース通知と /release-note の design を起こす (#148)


### Testing

- 過去の画像を view_attachment で開く e2e を足す (#145)


### Dependencies

- update all non-major dependencies


## [1.5.0] - 2026-09-21


### Added

- auto-generate README commands and requirements via pre-commit hook
- auto-generate README env vars table and switch setup to mise
- add CHANGELOG.md with git-cliff and /release skill
- add HMAC-authenticated admin endpoints
- add multimodal type extensions and model metadata
- show input/output modalities in /model set embed
- pass-through plugins in OpenRouter chat completion requests
- add attachmentParser and extend ChatService with multimodal input
- wire multimodal attachments into messageCreate handler
- add YAML frontmatter SSOT for design docs and auto-generate progress.md
- add OpenRouter app attribution headers
- migrate LLM chat responses to Components V2
- add client tool calling foundation
- improve model command details


### Fixed

- move open-pull-requests-limit to multi-ecosystem group level
- satisfy markdownlint MD029 in admin-endpoints design.md
- harden multimodal PDF handling and add default prompt fallback
- replace discontinued default model with gemma-4-26b
- mention handling, page footers, stop/error info improvements
- split chat responses by UTF-8 bytes as well as chars
- update status of tool calling foundation to implemented
- keep bun-types on the bun toolchain group
- keep pin updates out of the bun toolchain group
- stop Renovate pinning a digest into the zizmor version input
- close the gaps the accumulated review found
- pin bun-types so it moves with the runtime
- close the two gaps the hook review found
- complete Renovate migration safeguards
- preserve code fences across split messages
- accept OpenRouter final usage frames
- Coolify の Deploy Webhook を POST で呼び、手動起動もできるようにする (#95)
- keep the version status across gateway reconnects (#98)
- bun run preview を Components V2 の現行 UI に追従させる (#111)


### Refactoring

- address biome 2.4.11 useOptionalChain warnings
- extract HMAC-SHA256 helper into src/http/hmac.ts
- default model ID を envVars.ts に SSOT 化
- remove GitHub release notifications (#102)
- LLM 呼び出しを Chat Completions から Responses API へ載せ替える (#110)


### Documentation

- update v1.4.0 release date to 2026-01-14
- migrate to backlog-based roadmap and add markdownlint-cli2
- adopt change-driven design workflow inspired by OpenSpec
- remove design.md and move references to CLAUDE.md
- add OAuth BYOK design for per-user/guild OpenRouter key connection
- add admin-endpoints design and backlog entries
- add code-execution design and backlog entry
- refine code-execution design with Components V2 and dev-only /run
- add default-model-ssot design and backlog entry
- add chat-response-v2 design and backlog entry
- rework code-execution design around per-call sandbox lifecycle
- tighten chat-response-v2 around Section / allowedMentions rules
- add persistent-sandbox notes to conversation-context, tighten default-model-ssot
- add .env.example to default-model-ssot scope
- unwrap mid-sentence line breaks in ui-preview docs
- add CI pipeline + Actions supply-chain hardening design
- revise web-search design: server tools + fxtwitter
- refresh change designs for latest library specs
- align change designs with revised plan template
- record ci-pipeline rollout results and add CI maintenance notes
- move CI maintenance notes from ci.yml to CLAUDE.md
- confirm bun ecosystem joins multi-ecosystem group (PR #53)
- add release-polling change design and backlog entry
- generalize admin-endpoints inbound wording to be product-agnostic
- add admin API specification (docs/admin-api.md)
- refresh default-model-ssot design.md with survey findings
- refresh multimodal change design.md
- unify CLAUDE.md to English and add investigating status
- add tool-calling foundation and agentic feature design docs
- refine agentic feature design docs toward convergence
- apply final review fixes to remaining agentic design docs
- update dependabot-pr skill with grouped-PR workflow and best practices
- add renovate-migration design doc
- mark chat-response-v2 as implemented after manual regression
- correct the drift and alert rationales
- retire the Dependabot-era operational notes
- record what the onboarding preview confirmed
- record the dashboard warning and the abandoned dependency
- check off the phase 1 gates the real PRs settled
- make AGENTS.md the shared agent source
- plan OpenRouter conversation and response improvements
- align backlog and output design boundaries
- align agent instruction files with the repository state
- rewrite AGENTS.md around what the code cannot say (#99)
- mark release changes as implemented (#104)
- add Responses API migration design and restructure backlog (#108)
- record OpenRouter schema and docs index as sources of truth (#109)
- record the two weekly Renovate cycles and timestamp lookup (#112)
- コード実行の design を OpenRouter shell server tool 前提へ書き直す (#114)
- record the shutdown and streaming split follow-ups (#116)
- メッセージの解説（コンテキストメニュー）の design を追加する (#121)


### Testing

- avoid cross-file console spy interference
- protect stop button component contract
- assert the stop button through toJSON
- テスト bot による e2e と、手動確認をリリースの条件にする運用を追加する (#115)
- e2e の最後にその回の費用を出す (#122)


### Dependencies

- bump dependencies
- bump @biomejs/biome from 2.4.6 to 2.4.7
- update biome.json schema to 2.4.7
- bump bun-types, markdownlint-cli2, and @biomejs/biome
- bump typescript from 5.9.3 to 6.0.2
- bump discord.js, biome, bun-types, @types/node, and lefthook
- bump @biomejs/biome from 2.4.10 to 2.4.11
- bump the all-dependencies group with 8 updates
- bump @types/node in the all-dependencies group (#59)
- bump the all-dependencies group with 3 updates
- bump the all-dependencies group across 1 directory with 3 updates
- bump the all-dependencies group across 1 directory with 3 updates
- bump the all-dependencies group with 6 updates
- update all non-major dependencies
- update zizmor
- update all non-major dependencies
- pin dependencies
- update all non-major dependencies
- update bun toolchain to v1.4.0
- update all non-major dependencies
- update zizmor
- update all non-major dependencies
- update bun toolchain to v1.4.2


## [1.4.0] - 2026-01-14


### Added

- implement v1.4.0 streaming, stop button, prefix removal, auto-reply channels


### Fixed

- v1.4.0 streaming UX improvements and bug fixes


### Documentation

- remove v1.3.4 section from design.md (implemented)


## [1.3.4] - 2025-12-30


### Fixed

- implement v1.3.4 setGuildModel settings overwrite bug fix


### Documentation

- add release notes guideline for user-facing content only
- add v1.3.4 bug fix plan for setGuildModel settings overwrite


## [1.3.3] - 2025-12-30


### Added

- implement v1.3.3 model details display improvements


### Documentation

- update CLAUDE.md with detailed documentation workflow
- revise roadmap v1.4.0-v1.10.0 with UX-first approach


## [1.3.2] - 2025-12-28


### Added

- implement v1.3.2 UX improvements


## [1.3.1] - 2025-12-28


### Added

- implement v1.3.1 UX improvements


### Documentation

- Add v1.3.1 UX improvements to roadmap
- Update v1.3.1 message splitting design based on byte limit findings


## [1.3.0] - 2025-12-28


### Added

- implement v1.3.0 improvements and pending tasks


## [1.2.1] - 2025-12-28


### Added

- implement v1.2.1 quick wins


### Documentation

- Update design and progress documentation for v1.2.1 and v1.3.0 features


## [1.2.0] - 2025-12-28


### Added

- implement v1.2.0 Embed with model name display


### Documentation

- Update progress documentation and remove outdated requirements and test plan
- Add v1.3.0 streaming and v1.5.0 parameter configuration to roadmap


## [1.1.1] - 2025-12-25


### Added

- add resilience enhancements with global error handler and fallback mechanisms


### Documentation

- Update design and progress documentation with future schema plans and roadmap
- Added model selection UI design (Autocomplete method)
- add v1.4.0 context-aware conversation design


## [1.1.0] - 2025-12-24


### Added

- Add free models restriction and cache control
- improve error handling for model errors and rate limits
- add GitHub release notification feature


### Documentation

- Added user error display and release note delivery functionality
- Reorganize documentation structure
- add Dependabot PR handling skill
- Add more details regarding error handling (OpenRouter error format, output detail level settings)


### Dependencies

- bump @biomejs/biome from 2.3.9 to 2.3.10
- bump @types/node from 25.0.2 to 25.0.3
- bump zod from 4.2.0 to 4.2.1
- bump bun-types from 1.3.4 to 1.3.5


## [1.0.1] - 2025-12-18


### Added

- Add health check functionality with HTTP endpoint and update documentation


### Documentation

- Added GitHub Actions for automatic Coolify deployment, completing v1.0.0 release
- Add repository section with GitHub link to CLAUDE.md
- Update documentation tables for consistency and clarity


## [1.0.0] - 2025-12-18


### Added

- add VSCode settings for Biome formatter configuration
- Add complete command handler implementation and test plan
- Add Manual .env file loading
- Update command structure and remove deprecated commands in DisQord
- Convert the default model to an environment variable and update related documentation
- Changed the default model from 'openai/gpt-oss-120b:free' to 'deepseek/deepseek-r1-0528:free' and updated related documentation.
- Add completed tasks to the checklist and update deployment status
- Add deployment workflow to trigger Coolify on release


### Fixed

- Update biome.json to valid file exclusion patterns
- resolve type errors and lint issues
- update Biome schema version to 2.3.8 and adjust bun.lock configuration
- Optimize Dockerfile for dependency installation and add .dockerignore
- Update default LLM model to `google/gemini-2.0-flash-exp:free` across documentation and code


### Documentation

- added CLAUDE.md, AGENTS.md
- translate CLAUDE.md into English
- Update commit message guidelines to English only
- Add documentation section to AGENTS.md and CLAUDE.md
- Update issue templates and README for Bun and discord.js versions
- update Biome version to 2.3.8 in non-functional requirements
- add progress checklist for implementation tracking
- Update README and design documents to include Docker deployment instructions and security considerations
- Update progress checklist to include discord.js v15 corresponding item
- update Biome version reference in non-functional requirements
- Update development commands and tasks in documentation and configuration
- remove AGENTS.md and link to CLAUDE.md
- Update implementation progress checklist with UX and technical improvements
- Update implementation progress checklist with LLM response confirmation and deployment status
- Added management permission roles and channel restrictions to the database schema, incorporating functional requirements including model selection UI improvements and enhanced code quality


### Testing

- Add unit and integration tests (54 tests, 98% coverage)


### Dependencies

- bump bun-types from 1.3.3 to 1.3.4
- bump @biomejs/biome from 2.3.7 to 2.3.8
- bump zod from 3.25.76 to 4.1.13
- bump @types/node from 22.19.1 to 24.10.1
- bump @types/node from 25.0.0 to 25.0.2
- bump zod from 4.1.13 to 4.2.0
- bump @biomejs/biome from 2.3.8 to 2.3.9
<!-- ends the last list, so the link definitions below are not read as part of its final item -->
[1.13.0]: https://github.com/AtefAndrus/disqord/compare/v1.12.0...v1.13.0
[1.12.0]: https://github.com/AtefAndrus/disqord/compare/v1.11.1...v1.12.0
[1.11.1]: https://github.com/AtefAndrus/disqord/compare/v1.11.0...v1.11.1
[1.11.0]: https://github.com/AtefAndrus/disqord/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/AtefAndrus/disqord/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/AtefAndrus/disqord/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/AtefAndrus/disqord/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/AtefAndrus/disqord/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/AtefAndrus/disqord/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/AtefAndrus/disqord/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/AtefAndrus/disqord/compare/v1.3.4...v1.4.0
[1.3.4]: https://github.com/AtefAndrus/disqord/compare/v1.3.3...v1.3.4
[1.3.3]: https://github.com/AtefAndrus/disqord/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/AtefAndrus/disqord/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/AtefAndrus/disqord/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/AtefAndrus/disqord/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/AtefAndrus/disqord/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/AtefAndrus/disqord/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/AtefAndrus/disqord/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/AtefAndrus/disqord/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/AtefAndrus/disqord/compare/v1.0.0...v1.0.1

<!-- generated by git-cliff -->
