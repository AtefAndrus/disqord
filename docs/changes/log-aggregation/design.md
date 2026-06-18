---
title: "ログ集約サービスのセルフホスト"
status: planned
priority: medium
summary: "VictoriaLogs / Loki / OpenObserve 等によるログ集約基盤"
---

# ログ集約サービスのセルフホスト

## Why

外部ログ集約サービスの導入により、Bot のログを長期保存・検索可能にする。
admin-endpoints の `GET /admin/logs` はローカルファイル保持のみで長期履歴に対応しないため、別途集約基盤が必要。
候補は VictoriaLogs / Grafana Loki monolithic / OpenObserve。

## Goals / Non-Goals

Phase 2 着手時に作成。

## Decisions

Phase 2 着手時に作成。

## Design

Phase 2 着手時に作成。

## Tasks

- [ ] 設計書の詳細作成
- [ ] docs/changes/log-aggregation/ 削除（リリース完了時、git 履歴がアーカイブ）
