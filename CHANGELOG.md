# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).



## [1.7.0] - 2026-09-24


### Added

- Web 検索の有無にかかわらず現在日時をモデルに渡す (#157)


### Fixed

- 現在日時が実際の日時であることをモデルに明示する (#156)
- Web 検索が無効でも過去の画像を開いた後の応答が失敗しないようにする (#158)


### Documentation

- E2e のモデル別の観測をシナリオの横へ移す (#155)
- E2e のギルド設定を DB で切り替えられることを書く (#159)


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
- Renovate-pr に lock の年齢の確認と手元での lookup の手順を足す (#127)
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

- Update all non-major dependencies


## [1.5.0] - 2026-09-21


### Added

- Auto-generate README commands and requirements via pre-commit hook
- Auto-generate README env vars table and switch setup to mise
- Add CHANGELOG.md with git-cliff and /release skill
- Add HMAC-authenticated admin endpoints
- Add multimodal type extensions and model metadata
- Show input/output modalities in /model set embed
- Pass-through plugins in OpenRouter chat completion requests
- Add attachmentParser and extend ChatService with multimodal input
- Wire multimodal attachments into messageCreate handler
- Add YAML frontmatter SSOT for design docs and auto-generate progress.md
- Add OpenRouter app attribution headers
- Migrate LLM chat responses to Components V2
- Add client tool calling foundation
- Improve model command details


### Fixed

- Move open-pull-requests-limit to multi-ecosystem group level
- Satisfy markdownlint MD029 in admin-endpoints design.md
- Harden multimodal PDF handling and add default prompt fallback
- Replace discontinued default model with gemma-4-26b
- Mention handling, page footers, stop/error info improvements
- Split chat responses by UTF-8 bytes as well as chars
- Update status of tool calling foundation to implemented
- Keep bun-types on the bun toolchain group
- Keep pin updates out of the bun toolchain group
- Stop Renovate pinning a digest into the zizmor version input
- Close the gaps the accumulated review found
- Pin bun-types so it moves with the runtime
- Close the two gaps the hook review found
- Complete Renovate migration safeguards
- Preserve code fences across split messages
- Accept OpenRouter final usage frames
- Coolify の Deploy Webhook を POST で呼び、手動起動もできるようにする (#95)
- Keep the version status across gateway reconnects (#98)
- Bun run preview を Components V2 の現行 UI に追従させる (#111)


### Refactoring

- Address biome 2.4.11 useOptionalChain warnings
- Extract HMAC-SHA256 helper into src/http/hmac.ts
- Default model ID を envVars.ts に SSOT 化
- Remove GitHub release notifications (#102)
- LLM 呼び出しを Chat Completions から Responses API へ載せ替える (#110)


### Documentation

- Update v1.4.0 release date to 2026-01-14
- Migrate to backlog-based roadmap and add markdownlint-cli2
- Adopt change-driven design workflow inspired by OpenSpec
- Remove design.md and move references to CLAUDE.md
- Add OAuth BYOK design for per-user/guild OpenRouter key connection
- Add admin-endpoints design and backlog entries
- Add code-execution design and backlog entry
- Refine code-execution design with Components V2 and dev-only /run
- Add default-model-ssot design and backlog entry
- Add chat-response-v2 design and backlog entry
- Rework code-execution design around per-call sandbox lifecycle
- Tighten chat-response-v2 around Section / allowedMentions rules
- Add persistent-sandbox notes to conversation-context, tighten default-model-ssot
- Add .env.example to default-model-ssot scope
- Unwrap mid-sentence line breaks in ui-preview docs
- Add CI pipeline + Actions supply-chain hardening design
- Revise web-search design: server tools + fxtwitter
- Refresh change designs for latest library specs
- Align change designs with revised plan template
- Record ci-pipeline rollout results and add CI maintenance notes
- Move CI maintenance notes from ci.yml to CLAUDE.md
- Confirm bun ecosystem joins multi-ecosystem group (PR #53)
- Add release-polling change design and backlog entry
- Generalize admin-endpoints inbound wording to be product-agnostic
- Add admin API specification (docs/admin-api.md)
- Refresh default-model-ssot design.md with survey findings
- Refresh multimodal change design.md
- Unify CLAUDE.md to English and add investigating status
- Add tool-calling foundation and agentic feature design docs
- Refine agentic feature design docs toward convergence
- Apply final review fixes to remaining agentic design docs
- Update dependabot-pr skill with grouped-PR workflow and best practices
- Add renovate-migration design doc
- Mark chat-response-v2 as implemented after manual regression
- Correct the drift and alert rationales
- Retire the Dependabot-era operational notes
- Record what the onboarding preview confirmed
- Record the dashboard warning and the abandoned dependency
- Check off the phase 1 gates the real PRs settled
- Make AGENTS.md the shared agent source
- Plan OpenRouter conversation and response improvements
- Align backlog and output design boundaries
- Align agent instruction files with the repository state
- Rewrite AGENTS.md around what the code cannot say (#99)
- Mark release changes as implemented (#104)
- Add Responses API migration design and restructure backlog (#108)
- Record OpenRouter schema and docs index as sources of truth (#109)
- Record the two weekly Renovate cycles and timestamp lookup (#112)
- コード実行の design を OpenRouter shell server tool 前提へ書き直す (#114)
- Record the shutdown and streaming split follow-ups (#116)
- メッセージの解説（コンテキストメニュー）の design を追加する (#121)


### Testing

- Avoid cross-file console spy interference
- Protect stop button component contract
- Assert the stop button through toJSON
- テスト bot による e2e と、手動確認をリリースの条件にする運用を追加する (#115)
- E2e の最後にその回の費用を出す (#122)


### Dependencies

- Bump dependencies
- Bump @biomejs/biome from 2.4.6 to 2.4.7
- Update biome.json schema to 2.4.7
- Bump bun-types, markdownlint-cli2, and @biomejs/biome
- Bump typescript from 5.9.3 to 6.0.2
- Bump discord.js, biome, bun-types, @types/node, and lefthook
- Bump @biomejs/biome from 2.4.10 to 2.4.11
- Bump the all-dependencies group with 8 updates
- Bump @types/node in the all-dependencies group (#59)
- Bump the all-dependencies group with 3 updates
- Bump the all-dependencies group across 1 directory with 3 updates
- Bump the all-dependencies group across 1 directory with 3 updates
- Bump the all-dependencies group with 6 updates
- Update all non-major dependencies
- Update zizmor
- Update all non-major dependencies
- Pin dependencies
- Update all non-major dependencies
- Update bun toolchain to v1.4.0
- Update all non-major dependencies
- Update zizmor
- Update all non-major dependencies
- Update bun toolchain to v1.4.2


## [1.4.0] - 2026-01-14


### Added

- Implement v1.4.0 streaming, stop button, prefix removal, auto-reply channels


### Fixed

- V1.4.0 streaming UX improvements and bug fixes


### Documentation

- Remove v1.3.4 section from design.md (implemented)


## [1.3.4] - 2025-12-30


### Fixed

- Implement v1.3.4 setGuildModel settings overwrite bug fix


### Documentation

- Add release notes guideline for user-facing content only
- Add v1.3.4 bug fix plan for setGuildModel settings overwrite


## [1.3.3] - 2025-12-30


### Added

- Implement v1.3.3 model details display improvements


### Documentation

- Update CLAUDE.md with detailed documentation workflow
- Revise roadmap v1.4.0-v1.10.0 with UX-first approach


## [1.3.2] - 2025-12-28


### Added

- Implement v1.3.2 UX improvements


## [1.3.1] - 2025-12-28


### Added

- Implement v1.3.1 UX improvements


### Documentation

- Add v1.3.1 UX improvements to roadmap
- Update v1.3.1 message splitting design based on byte limit findings


## [1.3.0] - 2025-12-28


### Added

- Implement v1.3.0 improvements and pending tasks


## [1.2.1] - 2025-12-28


### Added

- Implement v1.2.1 quick wins


### Documentation

- Update design and progress documentation for v1.2.1 and v1.3.0 features


## [1.2.0] - 2025-12-28


### Added

- Implement v1.2.0 Embed with model name display


### Documentation

- Update progress documentation and remove outdated requirements and test plan
- Add v1.3.0 streaming and v1.5.0 parameter configuration to roadmap


## [1.1.1] - 2025-12-25


### Added

- Add resilience enhancements with global error handler and fallback mechanisms


### Documentation

- Update design and progress documentation with future schema plans and roadmap
- Added model selection UI design (Autocomplete method)
- Add v1.4.0 context-aware conversation design


## [1.1.0] - 2025-12-24


### Added

- Add free models restriction and cache control
- Improve error handling for model errors and rate limits
- Add GitHub release notification feature


### Documentation

- Added user error display and release note delivery functionality
- Reorganize documentation structure
- Add Dependabot PR handling skill
- Add more details regarding error handling (OpenRouter error format, output detail level settings)


### Dependencies

- Bump @biomejs/biome from 2.3.9 to 2.3.10
- Bump @types/node from 25.0.2 to 25.0.3
- Bump zod from 4.2.0 to 4.2.1
- Bump bun-types from 1.3.4 to 1.3.5


## [1.0.1] - 2025-12-18


### Added

- Add health check functionality with HTTP endpoint and update documentation


### Documentation

- Added GitHub Actions for automatic Coolify deployment, completing v1.0.0 release
- Add repository section with GitHub link to CLAUDE.md
- Update documentation tables for consistency and clarity


## [1.0.0] - 2025-12-18


### Added

- Add VSCode settings for Biome formatter configuration
- Add complete command handler implementation and test plan
- Add Manual .env file loading
- Update command structure and remove deprecated commands in DisQord
- Convert the default model to an environment variable and update related documentation
- Changed the default model from 'openai/gpt-oss-120b:free' to 'deepseek/deepseek-r1-0528:free' and updated related documentation.
- Add completed tasks to the checklist and update deployment status
- Add deployment workflow to trigger Coolify on release


### Fixed

- Update biome.json to valid file exclusion patterns
- Resolve type errors and lint issues
- Update Biome schema version to 2.3.8 and adjust bun.lock configuration
- Optimize Dockerfile for dependency installation and add .dockerignore
- Update default LLM model to `google/gemini-2.0-flash-exp:free` across documentation and code


### Documentation

- Added CLAUDE.md, AGENTS.md
- Translate CLAUDE.md into English
- Update commit message guidelines to English only
- Add documentation section to AGENTS.md and CLAUDE.md
- Update issue templates and README for Bun and discord.js versions
- Update Biome version to 2.3.8 in non-functional requirements
- Add progress checklist for implementation tracking
- Update README and design documents to include Docker deployment instructions and security considerations
- Update progress checklist to include discord.js v15 corresponding item
- Update Biome version reference in non-functional requirements
- Update development commands and tasks in documentation and configuration
- Remove AGENTS.md and link to CLAUDE.md
- Update implementation progress checklist with UX and technical improvements
- Update implementation progress checklist with LLM response confirmation and deployment status
- Added management permission roles and channel restrictions to the database schema, incorporating functional requirements including model selection UI improvements and enhanced code quality


### Testing

- Add unit and integration tests (54 tests, 98% coverage)


### Dependencies

- Bump bun-types from 1.3.3 to 1.3.4
- Bump @biomejs/biome from 2.3.7 to 2.3.8
- Bump zod from 3.25.76 to 4.1.13
- Bump @types/node from 22.19.1 to 24.10.1
- Bump @types/node from 25.0.0 to 25.0.2
- Bump zod from 4.1.13 to 4.2.0
- Bump @biomejs/biome from 2.3.8 to 2.3.9
<!-- ends the last list, so the link definitions below are not read as part of its final item -->
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
