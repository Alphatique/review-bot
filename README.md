# review-bot

Review pull requests with Claude and post the result as a **single Pull Request Review**: a summary in the review body plus inline comments anchored to the changed lines.

- Findings are posted where they belong, so each one can be discussed in its own thread.
- The state lives entirely in the review threads on GitHub. There is no database, no sticky comment, no hidden state block.
- Every run reviews the full `base...head` diff and reconciles it against the threads that already exist. Nothing is posted twice.
- The action resolves findings it judges to be fixed, and approves once nothing at or above `block-on` remains — so a pull request converges without anyone pressing a button.
- Numbering, deduplication, rendering and the submit decision are all done by the action. The model only reports through a single structured tool call.

## Quick start

`actions/checkout` is **required** — the agent reads files around the diff to build context.

```yaml
name: review

on:
  pull_request:
    types: [opened, synchronize, ready_for_review]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v6
      - uses: alphatique/review-bot@v1
        with:
          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

Use `anthropic-api-key` instead if you authenticate with an API key rather than a Claude subscription:

```yaml
- uses: alphatique/review-bot@v1
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Required permissions

```yaml
permissions:
  contents: read
  pull-requests: write
```

`pull-requests: write` is what lets the action submit the review. Without it the run fails.

## Inputs

| Input                     | Default                          | Description                                                                                                                                                                                                                                              |
| ------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code-oauth-token` | —                                | Claude subscription OAuth token. Either this or `anthropic-api-key` is required.                                                                                                                                                                         |
| `anthropic-api-key`       | —                                | Anthropic API key. Either this or `claude-code-oauth-token` is required.                                                                                                                                                                                 |
| `github-token`            | `${{ github.token }}`            | Token used to read the pull request and post the review.                                                                                                                                                                                                 |
| `repo`                    | current repository               | `owner/repo`.                                                                                                                                                                                                                                            |
| `pr-number`               | number in the event payload      | Pull request number.                                                                                                                                                                                                                                     |
| `instructions-file`       | `.github/review-instructions.md` | Path to a Markdown file describing what to review. Falls back to the built-in defaults.                                                                                                                                                                  |
| `exclude`                 | —                                | Additional glob patterns to exclude, one per line. Appended to the built-in defaults.                                                                                                                                                                    |
| `language`                | `en`                             | Output language for findings and the summary (`en` or `ja`).                                                                                                                                                                                             |
| `block-on`                | `major`                          | Submit `REQUEST_CHANGES` when an unresolved finding at or above this severity exists, otherwise `APPROVE` (`none`, `critical`, `major`, `minor`). `none` means the action always `APPROVE`s — see [`approve` is not a review](#approve-is-not-a-review). |
| `approve`                 | `true`                           | Let the action submit `APPROVE` when nothing at or above `block-on` remains. Set to `false` to never approve — this can leave a stale `REQUEST_CHANGES` standing; see [`approve` is not a review](#approve-is-not-a-review).                             |
| `auto-resolve`            | `true`                           | Let the action resolve findings it judges to be fixed in the current code. Set to `false` to only ever read thread state.                                                                                                                                |
| `fail-on-error`           | `true`                           | Fail the action when the review itself could not be completed.                                                                                                                                                                                           |
| `fail-on-incomplete`      | `false`                          | Fail the action when files were skipped because the diff exceeded the size limit.                                                                                                                                                                        |
| `model`                   | `claude-sonnet-5`                | Claude model to use.                                                                                                                                                                                                                                     |
| `effort`                  | `high`                           | Reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`).                                                                                                                                                                                              |
| `max-retries`             | `3`                              | How many times to retry when the agent fails to report findings.                                                                                                                                                                                         |
| `timeout-minutes`         | `8`                              | Wall-clock timeout for a single agent run.                                                                                                                                                                                                               |
| `max-cost-usd`            | `5`                              | Budget ceiling for a single agent run.                                                                                                                                                                                                                   |
| `diff-max-bytes`          | `500000`                         | Maximum total diff size sent to the model.                                                                                                                                                                                                               |

## Outputs

| Output             | Description                                                      |
| ------------------ | ---------------------------------------------------------------- |
| `status`           | `success` or `failed`                                            |
| `review-event`     | `COMMENT`, `REQUEST_CHANGES`, `APPROVE`, or `NONE`               |
| `findings-count`   | Number of new findings posted                                    |
| `resolved-count`   | Number of findings this run resolved automatically               |
| `critical-count`   | Number of new `critical` findings                                |
| `major-count`      | Number of new `major` findings                                   |
| `minor-count`      | Number of new `minor` findings                                   |
| `incomplete-files` | Number of files skipped because the diff exceeded the size limit |

`findings-count` counts only findings that became a review thread. A finding the action discards — it pointed at a file outside the diff — or failed to post as a comment does **not** add to this count, and the run still reports `status: success`. A run that discards three `critical` findings can report `findings-count: 0`. Do not build a gate on this number; those same findings still keep the action from submitting `APPROVE`.

## Severity

Three levels, deliberately coarse so the judgement stays stable:

| Severity   | Meaning                                                          |
| ---------- | ---------------------------------------------------------------- |
| `critical` | Serious security issues, data loss, production-outage class bugs |
| `major`    | Clear functional bugs, serious performance problems              |
| `minor`    | Best-practice violations, small bugs, maintainability problems   |

## Default exclusions

These globs are always excluded. Anything you pass through `exclude` is **appended** to this list, never replaces it.

```
**/bun.lock
**/bun.lockb
**/package-lock.json
**/yarn.lock
**/pnpm-lock.yaml
**/Cargo.lock
**/poetry.lock
**/Gemfile.lock
**/composer.lock
**/go.sum
**/*.gen.*
**/*.generated.*
**/dist/**
**/build/**
**/vendor/**
**/node_modules/**
**/*.min.js
**/*.min.css
**/*.map
**/*.snap
```

## Review instructions

When `instructions-file` points at an existing file, its contents become the top of the prompt. Write it as plain Markdown — there is no schema:

```markdown
このプロジェクトのレビューでは次を重視してください。

- `packages/core` は副作用を持たないこと
- API 境界の型は必ず zod で検証すること
- インデントはタブ文字
```

If the file does not exist, these built-in instructions are used instead:

```markdown
あなたは熟練したコードレビュアーです。以下の変更差分をレビューしてください。

## レビュー観点

- コードの正しさ
- プロジェクト規約への準拠 — リポジトリルートおよび変更ファイルが属するディレクトリの `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` を Read で確認してから判断すること
- パフォーマンスへの影響
- セキュリティ上の考慮
- 保守性

## スキップするもの

- 型チェッカやリンタが既に検出する表層的な問題
- 自動生成ファイル、ロックファイル、バイナリ
- フォーマッタが解決するスタイルの問題

## 重大度

- `critical`: 重大なセキュリティ、データ破壊、本番停止級のバグ
- `major`: 明白な機能バグ、重大なパフォーマンス問題
- `minor`: ベストプラクティス違反、軽微なバグ、保守性の問題

## 方針

- 再現・自信のある指摘のみを含める。確信が持てないものは含めないか重大度を下げる。推測しない（recall より precision を優先）
- 各指摘の body は 2〜5 行。可能なら修正案を含める
- 必要に応じて Read / Grep / Glob で周辺コードを確認し、差分だけでは分からない文脈を補うこと
```

## How findings are tracked

A finding is identified by a hash of `file` + normalized `title`, embedded as an HTML comment at the end of each comment. Because the line number is not part of the identity, a finding is not posted twice when later commits shift it to a different line — as long as the model reproduces the same title.

When there is a diff to review, each run sends it to the model in full — never just what changed since the last review — together with the findings that already exist on the pull request: the resolved ones, always, so the model does not restate them; the still-open ones too, when `auto-resolve` is on, so it can judge which are now fixed. When the diff is empty, the action skips the model call entirely and decides purely from the existing thread state. Whatever the model does report, anything that matches an existing thread's key — resolved or not — is silently skipped instead of posted again.

Every finding becomes its own thread. When the line cannot be located in the diff, the comment is attached to the file instead of a line. Findings that point at a file outside the diff are discarded, and the action will not approve on a run where that happened.

## Automatic resolution

With `auto-resolve` enabled (the default), the model is also asked which of the existing unresolved findings are already fixed in the current code. Each one it is confident about is resolved, and the action replies to the thread first with its reasoning, so the judgement is auditable and you get a notification.

The action never un-resolves anything. If it resolved something it should not have, press **Unresolve** — the next run counts it as outstanding again, and it will not be resolved a second time unless the model still believes it is fixed.

Findings resolved by a human are never re-raised. The action does not distinguish who resolved a thread when counting what is outstanding.

## Skipping a review

The action does not parse the pull request body. Express skip conditions in your workflow instead:

```yaml
jobs:
  review:
    if: |
      github.event.pull_request.draft == false
      && !contains(github.event.pull_request.body, '[skip-review]')
      && github.event.pull_request.user.login != 'dependabot[bot]'
```

The same applies to per-PR overrides such as the model:

```yaml
with:
  model: ${{ contains(github.event.pull_request.body, '[review-model:opus]') && 'claude-opus-5' || 'claude-sonnet-5' }}
```

## `approve` is not a review

**Do not use the bot's approval as a branch protection gate.**

The same model reports the findings, decides which ones are fixed, and therefore decides whether the pull request gets approved. The diff it reads is attacker-controllable data. With `auto-resolve` and `approve` both enabled — the defaults — there is a path where a pull request turns green without a human ever looking at it.

That is the trade this action makes for the convenience, and it is the right trade for a repository where the bot is an assistant. It is the wrong trade if the bot's approval is what satisfies "required approvals". If you enforce approvals, require a human one.

There is a second hole worth knowing about: the action does not care who resolved a thread. A pull request author can resolve everything by hand and collect the approval. This mirrors how GitHub itself treats resolution in "Require conversation resolution before merging", but it is a self-approval path all the same.

Set `block-on: none` to stop the action from ever submitting `REQUEST_CHANGES` — but know what that combines into. With `approve` at its default of `true`, nothing then ever meets the blocking bar, so the action always submits `APPROVE`, even with an unresolved `critical` finding sitting on the pull request. `block-on: none` does not mean "never block"; it means "always approve".

Set `approve: false` to keep the verdict at `COMMENT` and `REQUEST_CHANGES` only. There is a trap here too: once outstanding findings drop below `block-on`, the verdict the action wants to submit becomes `COMMENT` — and `COMMENT` never overwrites what GitHub shows as the review decision. A `REQUEST_CHANGES` the action submitted earlier stays live; the action does not dismiss it (dismissal only happens when a run fails outright, see below). Someone has to dismiss it by hand, or you re-enable `approve`.

`REQUEST_CHANGES` and `APPROVE` cannot be submitted on a pull request opened by a bot. The action detects this and falls back to `COMMENT`.

## Fail-closed behaviour

`fail-on-error` (default `true`) fails the job when the review could not be produced at all — timeout, budget exhausted, the model never reported findings, or the API call failed. This exists so a pull request never turns green just because nothing reviewed it. The failure is also posted as a review comment. When a run fails and the action has an approval standing on the pull request, that approval is dismissed. Otherwise `fail-on-error` would fail the job while the pull request stayed green.

`fail-on-incomplete` (default `false`) fails the job when files were dropped because the diff exceeded `diff-max-bytes`. Those files are always listed in the summary regardless of this setting.

## Not supported

- **Pull requests from forks.** `GITHUB_TOKEN` is read-only for fork pull requests, so the review cannot be posted. The action detects this and fails with an explicit message.
- **`pull_request_target`.** Running untrusted code with access to your secrets is not something this action will help you do. Use `pull_request`.
- `suggestion` blocks (one-click apply).
- A repository configuration file. Configuration is action inputs plus the instructions Markdown.

## What the agent is allowed to do

The agent runs with `Read`, `Grep`, `Glob` and a single custom tool for reporting findings. `Bash`, `Write`, `Edit`, `NotebookEdit`, `WebFetch`, `WebSearch` and `Task` are explicitly denied. It gets an allowlisted environment — no `GITHUB_TOKEN`, no `INPUT_*` variables — and no settings are loaded from the runner or the repository.

The diff is declared to the model as untrusted, attacker-controllable data, and instructions found inside it are to be ignored.

## License

MIT
