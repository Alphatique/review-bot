# review-bot

Review pull requests with Claude and post the result as a **single Pull Request Review**: a summary in the review body plus inline comments anchored to the changed lines.

- Findings are posted where they belong, so each one can be discussed in its own thread.
- The state lives in the review threads on GitHub. There is no database, no hidden state block, no display IDs.
- Reviews are incremental by default: after the first run only the changes since the last review are sent to the model.
- Numbering, deduplication, rendering and the submit decision are all done by the action. The model only reports findings through a single structured tool call.

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

| Input                     | Default                          | Description                                                                                                         |
| ------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `claude-code-oauth-token` | —                                | Claude subscription OAuth token. Either this or `anthropic-api-key` is required.                                    |
| `anthropic-api-key`       | —                                | Anthropic API key. Either this or `claude-code-oauth-token` is required.                                            |
| `github-token`            | `${{ github.token }}`            | Token used to read the pull request and post the review.                                                            |
| `repo`                    | current repository               | `owner/repo`.                                                                                                       |
| `pr-number`               | number in the event payload      | Pull request number.                                                                                                |
| `mode`                    | `auto`                           | `auto` reviews the changes since the last review, `full` reviews the whole diff.                                    |
| `instructions-file`       | `.github/review-instructions.md` | Path to a Markdown file describing what to review. Falls back to the built-in defaults.                             |
| `exclude`                 | —                                | Additional glob patterns to exclude, one per line. Appended to the built-in defaults.                               |
| `language`                | `en`                             | Output language for findings and the summary (`en` or `ja`).                                                        |
| `request-changes-on`      | `critical`                       | Submit as `REQUEST_CHANGES` when a finding at or above this severity exists (`none`, `critical`, `major`, `minor`). |
| `fail-on-error`           | `true`                           | Fail the action when the review itself could not be completed.                                                      |
| `fail-on-incomplete`      | `false`                          | Fail the action when files were skipped because the diff exceeded the size limit.                                   |
| `model`                   | `claude-sonnet-5`                | Claude model to use.                                                                                                |
| `effort`                  | `high`                           | Reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`).                                                         |
| `max-retries`             | `3`                              | How many times to retry when the agent fails to report findings.                                                    |
| `timeout-minutes`         | `8`                              | Wall-clock timeout for a single agent run.                                                                          |
| `max-cost-usd`            | `5`                              | Budget ceiling for a single agent run.                                                                              |
| `diff-max-bytes`          | `500000`                         | Maximum total diff size sent to the model.                                                                          |

## Outputs

| Output             | Description                                                      |
| ------------------ | ---------------------------------------------------------------- |
| `status`           | `success` or `failed`                                            |
| `review-event`     | `COMMENT`, `REQUEST_CHANGES`, or `NONE`                          |
| `findings-count`   | Number of new findings posted                                    |
| `critical-count`   | Number of new `critical` findings                                |
| `major-count`      | Number of new `major` findings                                   |
| `minor-count`      | Number of new `minor` findings                                   |
| `incomplete-files` | Number of files skipped because the diff exceeded the size limit |

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

## Incremental reviews

The action finds its own last review by a marker embedded in the review body, and diffs from that commit to the pull request head. The first run diffs from the base commit.

A finding is identified by a hash of `file` + normalized `title`, embedded as an HTML comment at the end of each inline comment. Because the line number is not part of the identity, a finding is not posted twice when later commits shift it to a different line. Findings you have already resolved are **not** re-posted either — resolving a thread is a human decision and the action does not reopen it.

To force a review of the whole diff again:

```yaml
- uses: alphatique/review-bot@v1
  with:
    mode: full
```

`mode: full` still deduplicates against existing comments, so it does not repost what is already there.

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

## `request-changes-on` and branch protection

`request-changes-on` only decides whether the review is submitted as `REQUEST_CHANGES` or `COMMENT`. It does **not** fail the job, and it is not a security boundary — the severity comes from model output, which untrusted diff content can influence.

If you want a review to actually block a merge, enforce it with branch protection (require review approval / dismiss stale reviews). That decision belongs on the repository, not in this action.

`REQUEST_CHANGES` cannot be submitted on a pull request opened by the same identity as the token. When the pull request author is a bot, the action falls back to `COMMENT` automatically.

## Fail-closed behaviour

`fail-on-error` (default `true`) fails the job when the review could not be produced at all — timeout, budget exhausted, the model never reported findings, or the API call failed. This exists so a pull request never turns green just because nothing reviewed it. The failure is also posted as a review comment, and that comment is marked so it never becomes the starting point of the next incremental review.

`fail-on-incomplete` (default `false`) fails the job when files were dropped because the diff exceeded `diff-max-bytes`. Those files are always listed in the summary regardless of this setting.

## Not supported

- **Pull requests from forks.** `GITHUB_TOKEN` is read-only for fork pull requests, so the review cannot be posted. The action detects this and fails with an explicit message.
- **`pull_request_target`.** Running untrusted code with access to your secrets is not something this action will help you do. Use `pull_request`.
- Replying to review threads / conversational follow-ups.
- `suggestion` blocks (one-click apply).
- A repository configuration file. Configuration is action inputs plus the instructions Markdown.

## What the agent is allowed to do

The agent runs with `Read`, `Grep`, `Glob` and a single custom tool for reporting findings. `Bash`, `Write`, `Edit`, `NotebookEdit`, `WebFetch`, `WebSearch` and `Task` are explicitly denied. It gets an allowlisted environment — no `GITHUB_TOKEN`, no `INPUT_*` variables — and no settings are loaded from the runner or the repository.

The diff is declared to the model as untrusted, attacker-controllable data, and instructions found inside it are to be ignored.

## License

MIT
