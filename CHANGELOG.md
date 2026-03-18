# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).



## [Unreleased]


### Added

- Auto-generate README commands and requirements via pre-commit hook
- Auto-generate README env vars table and switch setup to mise


### Dependencies

- Bump dependencies
- Bump @biomejs/biome from 2.4.6 to 2.4.7
- Update biome.json schema to 2.4.7


### Documentation

- Update v1.4.0 release date to 2026-01-14
- Migrate to backlog-based roadmap and add markdownlint-cli2
- Adopt change-driven design workflow inspired by OpenSpec
- Remove design.md and move references to CLAUDE.md


## [1.4.0] - 2026-01-14


### Added

- Implement v1.4.0 streaming, stop button, prefix removal, auto-reply channels


### Documentation

- Remove v1.3.4 section from design.md (implemented)


### Fixed

- V1.4.0 streaming UX improvements and bug fixes


## [1.3.4] - 2025-12-30


### Documentation

- Add release notes guideline for user-facing content only
- Add v1.3.4 bug fix plan for setGuildModel settings overwrite


### Fixed

- Implement v1.3.4 setGuildModel settings overwrite bug fix


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


### Dependencies

- Bump @biomejs/biome from 2.3.9 to 2.3.10
- Bump @types/node from 25.0.2 to 25.0.3
- Bump zod from 4.2.0 to 4.2.1
- Bump bun-types from 1.3.4 to 1.3.5


### Documentation

- Added user error display and release note delivery functionality
- Reorganize documentation structure
- Add Dependabot PR handling skill
- Add more details regarding error handling (OpenRouter error format, output detail level settings)


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


### Dependencies

- Bump bun-types from 1.3.3 to 1.3.4
- Bump @biomejs/biome from 2.3.7 to 2.3.8
- Bump zod from 3.25.76 to 4.1.13
- Bump @types/node from 22.19.1 to 24.10.1
- Bump @types/node from 25.0.0 to 25.0.2
- Bump zod from 4.1.13 to 4.2.0
- Bump @biomejs/biome from 2.3.8 to 2.3.9


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


### Fixed

- Update biome.json to valid file exclusion patterns
- Resolve type errors and lint issues
- Update Biome schema version to 2.3.8 and adjust bun.lock configuration
- Optimize Dockerfile for dependency installation and add .dockerignore
- Update default LLM model to `google/gemini-2.0-flash-exp:free` across documentation and code


### Testing

- Add unit and integration tests (54 tests, 98% coverage)
[unreleased]: https://github.com/AtefAndrus/disqord/compare/v1.4.0...HEAD
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
