---
id: wi_01a1f564-641f-7c6c-972f-5757c4fb6fef
slug: 2026-11-19-01-cue-generic-agent-job-queue
title: cue generic agent job queue
description: Build cue, a generic multi-harness job queue for coding agents on libeam, starting from the M0 scaffold.
status: active
visibility: team_shared
createdBy: 45464946+AlexandruCalinica@users.noreply.github.com
createdAt: "2026-11-19T19:59:19.583Z"
updatedAt: "2026-11-20T06:23:29.341Z"
---

# cue generic agent job queue

## Objective

Build cue: a generic TypeScript job queue on libeam that routes coding-agent jobs to any harness (Claude Code, Codex, Cursor, ...) and account by configurable rules, with SQLite persistence, isolated process trees and hook-based extension points, free of any org-specific logic.
