# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

Greenfield — tech selection is decided (below), but implementation has not started. As real code, build, and test commands land, replace the relevant sections here with concrete commands. Do not leave this as vision-only once code exists.

## What this project is (BanGD)

BanGD is an **AI PR review assistant specialized for the database (BanDB) vertical domain**. It exists because general-purpose AI reviewers (Copilot, generic Claude review) catch *potential runtime problems* but stop at the lowest-effort fix (e.g. "make it synchronous") and reason at the code level, not the **database-architecture level**.

The review target is **changes to the BanDB database engine's own source** (BanDB is written in Go). So BanGD must reason like a **database systems engineer** — concurrency control, locking, MVCC, storage engine internals, memory management, WAL, schema evolution — not like a SQL-writing DBA.

Motivating example: when a memory block can **panic under concurrency**, a generic reviewer just serializes access; BanGD detects the hazard *and* reasons architecturally — e.g. proposing a **dual-table design** that removes the hazard and improves performance.

## Core design principle: review/acceptance, not authoring

Deliberate decoupling:
- **Old model:** the development side used local Claude Code to write and open PRs.
- **This project:** an **acceptance/review side** that inspects an existing PR and *proposes* architecture-level suggestions.

Bias every feature toward the **reviewer-of-an-existing-PR** role. Suggestions must explain the *architectural* rationale and trade-offs, not just flag the symptom. Standard output shape per finding:
`问题根因 → 为什么低级解法不够 → 架构级方案 → 代价/收益`

## Tech selection (decided)

| Layer | Choice |
|---|---|
| Language | **TypeScript** (BanGD is the tool; BanDB being Go does not force Go — the model reads Go fine) |
| Form factor | **GitHub Action first → Probot App later** |
| Model / SDK | **Claude Opus 4.x** via `@anthropic-ai/sdk`, with **prompt caching** on the large fixed blocks (system prompt, rubric, architecture docs) |
| GitHub integration | Octokit (Action phase) → Probot (App phase) |
| Code context | Let the model agentically read the repo; fetch the diff via Octokit |

### Architectural constraint that must hold from day one

The **core review logic must be a standalone module independent of the trigger**: `gather context → call Claude → parse structured result`. The GitHub Action and the future Probot App are thin shells that call this core. This is what makes the Action→App upgrade cheap — keep trigger/transport out of the core.

### The project's most valuable asset: the review rubric + few-shot

80% of review quality comes from a good **rubric** (concurrency safety, lock granularity, memory lifecycle, schema evolution, hot-path performance — each with "what to interrogate") plus **few-shot exemplars** of architecture-level reviews (like the concurrency-panic → dual-table example), plus letting the model read surrounding code. Treat these as the core intellectual asset, more important than any plumbing.

## Development conventions (required)

- **Atomic commits, commit + push per change.** Finish one self-contained change, then immediately commit and push it. One feature = one push. Keep commits small and frequent rather than batching many changes into one.
- **Tests are mandatory.** Every change ships with tests — every new function/feature must have tests. No exceptions.
- **No `any` in TypeScript.** `any` is forbidden. Use precise types, `unknown` + narrowing, or generics instead.

## Open questions (confirm before assuming)

- Exact PR-ingestion details and where the Action posts results (inline comments vs summary review).
- Whether to build an evaluation corpus of past PRs + expert reviews to quantify suggestion quality (recommended before trusting architecture-level advice).
