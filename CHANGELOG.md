# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).



## [1.17.1] - 2026-10-22


### Fixed

- Bun 1.4.4 で鍵が漏えいした eMudhra の CA の証明書を拒否する ([#240](https://github.com/AtefAndrus/disqord/pull/240))


## [1.17.0] - 2026-10-19


### Added

- リリースノートの PR 番号を PR へのリンクにする ([#235](https://github.com/AtefAndrus/disqord/pull/235))


### Fixed

- 発言へのリンクの文字と、同じ文に書かれた発言者名が重ならないようにする ([#237](https://github.com/AtefAndrus/disqord/pull/237))


## [1.16.0] - 2026-10-19


### Added

- client tool の呼び出しをログに残し、遡って読む tool の 0 件の結果を誤解されないようにする ([#227](https://github.com/AtefAndrus/disqord/pull/227))
- 発言者を表示名とユーザー名で区別し、発言へのリンクの文字を整える ([#228](https://github.com/AtefAndrus/disqord/pull/228))
- 会話履歴の発言に付いたリアクションの種類と数をモデルに渡す ([#229](https://github.com/AtefAndrus/disqord/pull/229))
- 自動応答の判定が人どうしの会話と制止に返答しないようにする ([#231](https://github.com/AtefAndrus/disqord/pull/231))


## [1.15.0] - 2026-10-17


### Added

- 自動応答チャンネルで、メンションの無い発言に返答するかを判定する ([#225](https://github.com/AtefAndrus/disqord/pull/225))


## [1.14.0] - 2026-10-17


### Added

- Release の公開でコンテナイメージを GHCR へ公開する ([#215](https://github.com/AtefAndrus/disqord/pull/215))
- 返答中の発言番号を、その発言へのメッセージリンクで表示する ([#222](https://github.com/AtefAndrus/disqord/pull/222))


### Fixed

- イメージ公開のタグ名を v<major>.<minor>.<patch> に限る ([#216](https://github.com/AtefAndrus/disqord/pull/216))
- デプロイ workflow で新しい版が本番で動き始めるまで待つ ([#218](https://github.com/AtefAndrus/disqord/pull/218))


### Dependencies

- update all non-major dependencies


## [1.13.0] - 2026-10-10


### Added

- ピン留め、チャンネル情報、イベントを読む tool を足す ([#203](https://github.com/AtefAndrus/disqord/pull/203))
- Discord のイベントを作る create_event を足す ([#204](https://github.com/AtefAndrus/disqord/pull/204))


## [1.12.0] - 2026-10-08


### Added

- 終了時に生成途中の返信を停止表示にしてから落とす ([#202](https://github.com/AtefAndrus/disqord/pull/202))


## [1.11.1] - 2026-10-08


### Fixed

- 失敗した OpenRouter の応答をログで区別し、定期実行の e2e で失敗理由を返す ([#196](https://github.com/AtefAndrus/disqord/pull/196))
- 返信先の別Bot引用とX展開を修正しE2Eで入力を検証 ([#198](https://github.com/AtefAndrus/disqord/pull/198))


### Dependencies

- update all non-major dependencies
- update jdx/mise-action action to v5


## [1.11.0] - 2026-10-01


### Added

- 会話の中の投票と締め切りの結果をモデルに渡す ([#193](https://github.com/AtefAndrus/disqord/pull/193))
- 定期実行のジョブで Web 検索を使えるようにする ([#195](https://github.com/AtefAndrus/disqord/pull/195))


## [1.10.0] - 2026-09-29


### Added

- 会話履歴の 24 時間の制限をなくし、tool の結果を context 予算で抑える ([#176](https://github.com/AtefAndrus/disqord/pull/176))
- モデルが会話の流れでリアクション、投票、スレッド作成、ピン留めを行えるようにする ([#178](https://github.com/AtefAndrus/disqord/pull/178))
- Discord で表示されない Markdown の表を使わないようモデルに指示する ([#182](https://github.com/AtefAndrus/disqord/pull/182))
- 登録したプロンプトを決まった時刻に実行して投稿する定期実行を追加する ([#188](https://github.com/AtefAndrus/disqord/pull/188))


### Fixed

- 断った設定変更を警告として記録し、preview の Chromium に Windows のフォントを使わせない ([#174](https://github.com/AtefAndrus/disqord/pull/174))
- ルーターのモデルで返答の見出しにフッタと同じモデルを出す ([#181](https://github.com/AtefAndrus/disqord/pull/181))


## [1.9.0] - 2026-09-25


### Added

- /config を設定パネルにし、許可チャンネルと管理ロールを設定できるようにする ([#169](https://github.com/AtefAndrus/disqord/pull/169))
- 新しい版で起動したら、設定したチャンネルへ変更点を通知する ([#170](https://github.com/AtefAndrus/disqord/pull/170))
- 設定パネルのチャンネル一覧を 1 つの選択欄で編集できるようにする ([#172](https://github.com/AtefAndrus/disqord/pull/172))


### Fixed

- 設定パネルの on/off ボタンを「有効にする」「無効にする」だけにし、状態で色を分ける ([#171](https://github.com/AtefAndrus/disqord/pull/171))


## [1.8.0] - 2026-09-25


### Added

- ギルド設定のすべての変更に共通の認可を掛ける ([#165](https://github.com/AtefAndrus/disqord/pull/165))
- /release-note で版ごとの変更点を表示する ([#166](https://github.com/AtefAndrus/disqord/pull/166))


## [1.7.0] - 2026-09-24


### Added

- Web 検索の有無にかかわらず現在日時をモデルに渡す ([#157](https://github.com/AtefAndrus/disqord/pull/157))


### Fixed

- 現在日時が実際の日時であることをモデルに明示する ([#156](https://github.com/AtefAndrus/disqord/pull/156))
- Web 検索が無効でも過去の画像を開いた後の応答が失敗しないようにする ([#158](https://github.com/AtefAndrus/disqord/pull/158))


## [1.6.0] - 2026-09-23


### Added

- ギルド単位で有効にできる Web 検索を追加する ([#129](https://github.com/AtefAndrus/disqord/pull/129))
- Web 検索の上限を 1 リクエスト 4 回に上げる ([#131](https://github.com/AtefAndrus/disqord/pull/131))
- X のポストの URL を fxtwitter で展開してモデルに渡す ([#135](https://github.com/AtefAndrus/disqord/pull/135))
- 会話履歴を保存してモデルの文脈に使う ([#136](https://github.com/AtefAndrus/disqord/pull/136))
- 会話履歴を Discord から読み、窓の外は tool で取りに行く ([#140](https://github.com/AtefAndrus/disqord/pull/140))
- コマンドの返信を Components V2 にし、/status で設定を切り替えられるようにする ([#149](https://github.com/AtefAndrus/disqord/pull/149))
- モデルの推論を受け取り、送り返し、設定に応じて回答の上に表示する ([#150](https://github.com/AtefAndrus/disqord/pull/150))
- /status の各項目を項目名と値の 2 行で表示する ([#151](https://github.com/AtefAndrus/disqord/pull/151))
- 回答の区切り線を Separator で描く ([#152](https://github.com/AtefAndrus/disqord/pull/152))


### Fixed

- 1 ページに収まる返信を最後の行だけ次のページに分けない ([#128](https://github.com/AtefAndrus/disqord/pull/128))
- 回答フッターの所要時間を Latency ではなく Time と秒で表示する ([#130](https://github.com/AtefAndrus/disqord/pull/130))
- 同時に走ったギルド設定の変更が互いを消さないようにする ([#132](https://github.com/AtefAndrus/disqord/pull/132))
- ツイート展開と会話履歴の設定の注意書きを Discord 上から削る ([#137](https://github.com/AtefAndrus/disqord/pull/137))
- 会話履歴で過去の添付を送り直さず表記にする ([#138](https://github.com/AtefAndrus/disqord/pull/138))
- 最終ターンの tool 呼び出しに本文が付いていれば、その本文で答える ([#142](https://github.com/AtefAndrus/disqord/pull/142))
- Web 検索が失敗したら検索なしで答え直す ([#153](https://github.com/AtefAndrus/disqord/pull/153))


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
- Coolify の Deploy Webhook を POST で呼び、手動起動もできるようにする ([#95](https://github.com/AtefAndrus/disqord/pull/95))
- keep the version status across gateway reconnects ([#98](https://github.com/AtefAndrus/disqord/pull/98))
- bun run preview を Components V2 の現行 UI に追従させる ([#111](https://github.com/AtefAndrus/disqord/pull/111))


### Dependencies

- bump dependencies
- bump @biomejs/biome from 2.4.6 to 2.4.7
- update biome.json schema to 2.4.7
- bump bun-types, markdownlint-cli2, and @biomejs/biome
- bump typescript from 5.9.3 to 6.0.2
- bump discord.js, biome, bun-types, @types/node, and lefthook
- bump @biomejs/biome from 2.4.10 to 2.4.11
- bump the all-dependencies group with 8 updates
- bump @types/node in the all-dependencies group ([#59](https://github.com/AtefAndrus/disqord/pull/59))
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


## [1.3.4] - 2025-12-30


### Fixed

- implement v1.3.4 setGuildModel settings overwrite bug fix


## [1.3.3] - 2025-12-30


### Added

- implement v1.3.3 model details display improvements


## [1.3.2] - 2025-12-28


### Added

- implement v1.3.2 UX improvements


## [1.3.1] - 2025-12-28


### Added

- implement v1.3.1 UX improvements


## [1.3.0] - 2025-12-28


### Added

- implement v1.3.0 improvements and pending tasks


## [1.2.1] - 2025-12-28


### Added

- implement v1.2.1 quick wins


## [1.2.0] - 2025-12-28


### Added

- implement v1.2.0 Embed with model name display


## [1.1.1] - 2025-12-25


### Added

- add resilience enhancements with global error handler and fallback mechanisms


## [1.1.0] - 2025-12-24


### Added

- Add free models restriction and cache control
- improve error handling for model errors and rate limits
- add GitHub release notification feature


### Dependencies

- bump @biomejs/biome from 2.3.9 to 2.3.10
- bump @types/node from 25.0.2 to 25.0.3
- bump zod from 4.2.0 to 4.2.1
- bump bun-types from 1.3.4 to 1.3.5


## [1.0.1] - 2025-12-18


### Added

- Add health check functionality with HTTP endpoint and update documentation


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


### Dependencies

- bump bun-types from 1.3.3 to 1.3.4
- bump @biomejs/biome from 2.3.7 to 2.3.8
- bump zod from 3.25.76 to 4.1.13
- bump @types/node from 22.19.1 to 24.10.1
- bump @types/node from 25.0.0 to 25.0.2
- bump zod from 4.1.13 to 4.2.0
- bump @biomejs/biome from 2.3.8 to 2.3.9
<!-- ends the last list, so the link definitions below are not read as part of its final item -->
[1.17.1]: https://github.com/AtefAndrus/disqord/compare/v1.17.0...v1.17.1
[1.17.0]: https://github.com/AtefAndrus/disqord/compare/v1.16.0...v1.17.0
[1.16.0]: https://github.com/AtefAndrus/disqord/compare/v1.15.0...v1.16.0
[1.15.0]: https://github.com/AtefAndrus/disqord/compare/v1.14.0...v1.15.0
[1.14.0]: https://github.com/AtefAndrus/disqord/compare/v1.13.0...v1.14.0
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
