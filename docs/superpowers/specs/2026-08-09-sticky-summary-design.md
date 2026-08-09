# sticky サマリーコメント設計

- 日付: 2026-08-09
- 状態: 設計確定 / 未実装

## 背景

現状の `runReview` は毎回 `createReview` で新しい Review を作る（`src/orchestrate.ts:180`）。結果として 2 つの問題がある。

1. **サマリーが積み上がる。** push のたびに Review が増え、`新規の指摘はありません。` だけの Review も Conversation タブに残り続ける。
2. **サマリーが今回の新規分しか語らない**（`src/core/render.ts:36`）。件数と「行を特定できなかった指摘」しか出ないため、PR 全体でいま何が未解決なのかを一箇所で把握できない。インラインに投稿した指摘はサマリーに一切載らないので索引としても機能しない。

必要な情報は既に手元にある。`listExistingFindings()` が PR 上の全指摘とその解決状態を取得しているが、`decideEvent` の判定に使われるだけで捨てられている（`src/orchestrate.ts:142`）。

## 目的

PR ごとに **1 つの、更新され続ける状態ボード**を持つ。PR を開いた人が最初に見るべきなのは「いま何が残っているか」であり、「今回何を新しく言ったか」ではない。

## 決定事項

| 論点              | 決定                                                                        |
| ----------------- | --------------------------------------------------------------------------- |
| sticky の置き場所 | PR の issue comment。Review は毎回作らない                                  |
| 状態の保持        | 分散マーカー方式。sticky に隠し JSON は置かない                             |
| サマリーの形      | 未解決は平積みリンク一覧、解決済み・履歴・実行情報は折りたたみ              |
| 指摘 body         | サマリーに複製せずスレッドに置いたまま。サマリーは索引に徹する              |
| Review の作成     | 新規インラインコメントがあるか、イベント状態を変えたいときだけ              |
| 実行コスト        | `run` マーカーに毎回記録し、sticky に PR 全体の累計を出す。失敗回も記録する |
| sticky の更新     | 常に edit。削除して再投稿はしない                                           |
| APPROVE           | opt-in（`approve` input、既定 `false`）。未解決 0 件のときだけ              |
| 手動 resolve      | 誰が resolve したかは問わない。resolve を「対応済みの意思表示」とみなす     |
| outdated          | 未解決として数え、行に `(outdated)` を付す                                  |

---

## 1. アーキテクチャ転換

**「Review が状態を持つ」から「sticky コメントが状態を持ち、Review はイベントとインラインコメントの運搬手段になる」へ。**

この転換により既存のマーカーが 2 つとも不要になる。

- 増分の起点は sticky の `reviewed=<sha>` から読む。Review 一覧を走査する `getLastReviewedCommit()` は消える → **`SUMMARY_MARKER` 不要**
- 失敗通知は Review ではなく sticky 先頭のバナーとして出す。失敗時は `reviewed` を進めないので次回そのまま再レビューされる → **`FAILURE_MARKER` 不要**

`src/core/marker.ts` は正味で単純になる。

## 2. sticky サマリーの形

日本語・未解決 3 件・2 回目のレビューという想定。

```markdown
## 🤖 コードレビュー

`a1b2c3d` までレビュー済み · 未解決 **3** 件 · 🔴 1 / 🟠 1 / 🟡 1

### 未解決の指摘

- 🔴 [トークンが例外メッセージ経由でログに出る](#link) — `src/io/github.ts:88`
- 🟠 [reviewThreads のページングが打ち切られる](#link) — `src/io/github.ts:103` (outdated)
- 🟡 [空配列の分岐が render と orchestrate で重複](#link) — `src/core/render.ts:47`

<details><summary>解決済み (4)</summary>

- 🟠 ~~[N+1 クエリになっている](#link)~~ — `src/io/github.ts:131`

</details>

<details><summary>レビュー履歴 (3 回 · 合計 $0.61)</summary>

| commit    | 範囲 | 新規 | 判定               | コスト |
| --------- | ---- | ---- | ------------------ | ------ |
| `a1b2c3d` | 増分 | 1    | 💬 COMMENT         | $0.18  |
| `77aa88b` | 増分 | —    | ⚠️ 失敗            | $0.12  |
| `9f8e7d6` | 全体 | 3    | 🔴 REQUEST_CHANGES | $0.31  |

</details>

<details><summary>実行情報</summary>

今回: `claude-sonnet-5` · effort `high` · 42s · $0.18（1 回目で成功）

</details>

<!-- review-bot:v1 sticky reviewed=a1b2c3d -->
<!-- review-bot:v1 run commit=9f8e7d6 mode=full new=3 event=REQUEST_CHANGES cost=0.3104 sec=58 attempts=1 model=claude-sonnet-5 effort=high -->
<!-- review-bot:v1 run commit=77aa88b mode=auto new=0 event=FAILED cost=0.1233 sec=480 attempts=3 model=claude-sonnet-5 effort=high -->
<!-- review-bot:v1 run commit=a1b2c3d mode=auto new=1 event=COMMENT cost=0.1817 sec=42 attempts=1 model=claude-sonnet-5 effort=high -->
```

意図した性質:

- **`### 未解決の指摘` は折りたたまない。** 折りたたむと通知メールや PR 一覧のプレビューで内容が消える。
- **解決済みは常に折りたたむ。** 長い PR で肥大するため、`<summary>` に件数を出して中身は畳む。
- **各行はスレッドへのリンク。** サマリーは索引であって議論の場ではない。
- 未解決が 0 件のときは `### 未解決の指摘` セクションごと省き、冒頭の状態行を `` `a1b2c3d` までレビュー済み · 未解決の指摘はありません `` にする。
- **コストは毎回 `run` マーカーに記録し、累計を出す。** 履歴の `<summary>` に PR 全体の合計、テーブルに各回の内訳を出す。累計は `run` マーカーの `cost` を合計するだけで求まる。
- **`実行情報` セクションは最新回のみ。** 累計は履歴側にあるので重複させない。リトライした回は `（3 回目で成功）` のように attempt 数を添える。

失敗時は先頭に以下のバナーを差し込む。**それ以外のセクションはスレッドを取得し直して通常どおり再描画する**（エージェントが失敗しただけで GitHub API は生きているため）。前回の sticky 本文をパースして再利用することはしない。

**バナーが名指しする sha は `reviewed` ではなく head である。** 失敗時この 2 つは必ず食い違う（`reviewed` は最後に成功した地点に据え置かれ、head は今回レビューできなかったコミット）。混同すると「`abc123` は未レビューです」の 1 行下に「`abc123` までレビュー済み」が並ぶ。実装ではエラー本文と sha を必ず一組で渡す型にして、片方だけ差し替えられないようにする。

````markdown
> ⚠️ 自動レビューを完了できませんでした。`def4567` は未レビューです。ワークフローを再実行するか、ジョブのログを確認してください。
>
> <details><summary>エラー概要</summary>
>
> ```
> agent timed out after 8 minutes
> ```
>
> </details>
````

差分がサイズ上限を超えてファイルが落ちた場合の警告（現行の `oversizedWarning`）も同様にバナー領域に出す。

## 3. マーカー定義

```
インライン（既存のまま）  <!-- review-bot:v1 key=<12hex> sev=<severity> -->
sticky 本体              <!-- review-bot:v1 sticky reviewed=<sha> -->
実行履歴（sticky に追記） <!-- review-bot:v1 run commit=<sha> mode=auto|full new=<n>
                             event=<event> cost=<usd> sec=<n> attempts=<n>
                             model=<id> effort=<effort> -->
```

- `sticky` マーカーは sticky コメントの識別と増分起点の保持を兼ねる。1 コメントに 1 つ。
- `run` マーカーは実行のたびに 1 行追記する。履歴テーブルと累計コストはこのマーカー群から再構成する。1 行あたり 150 バイト程度。
- `event` は `COMMENT` / `REQUEST_CHANGES` / `APPROVE` / `NONE` / `FAILED` のいずれか。
  - **Review を作らなかった回（`NONE`）も記録する。** レビューが走った事実自体が履歴として意味を持つため。判定列には `—` を出す。
  - **失敗した回（`FAILED`）も記録する。** 失敗してもコストは発生しているので、記録しないと累計が実態より小さく出る。`reviewed=<sha>` を進めないことが「その commit はレビュー済みでない」ことを表すのであって、`run` マーカーの有無ではない。判定列には `⚠️ 失敗` を出す。
- `cost` は **その実行の全 attempt の合計**。`max-cost-usd` はエージェント 1 回あたりの上限なので、`max-retries` 回ぶん積み上がりうる。`attempts` を併記することでこれが読み取れる。
- `sec` は全 attempt の合計秒数（整数）。

**パース方針。** `run` マーカーは `key=value` の緩いパースにする。**未知のキーは無視し、欠損したキーは既定値**（`cost=0`、`sec=0`、`attempts=1`、`model`/`effort` は空）で埋める。こうしておけば、後からキーを足しても古いマーカーがそのまま読める。値は `[\w.:@/-]+` に制限し、外れた値は欠損扱いにする（`model` に任意文字列が来ても `-->` でマーカーを閉じられないようにするため）。

- インラインマーカーは既存実装のまま。パースは末尾一致を採用する既存の防御（`src/core/marker.ts:42`）を維持する。

**指摘タイトルの復元。** インラインコメント本文の 1 行目 `🔴 **critical** — <タイトル>` からパースする。書式は `renderInlineComment` が生成しているので安定する。パースに失敗した場合は `(タイトル不明)` とし、URL とファイルパスだけを出す。索引としては劣化しても機能する。

タイトルをマーカーに埋め込む案は採らない。タイトルには任意の文字が入りうるためエンコードが必要になり、マーカーが識別子以上のものになってしまう。

**タイトルの無害化。** タイトルはモデル出力であり、差分の内容に影響される。sticky に描画する直前に、`\s+` を 1 個の空白に潰し、`&`・`<`・`>` を実体参照にし、`\`・`[`・`]` をエスケープする。潰さない場合、次の 3 つが起きる。

- `]` を含むタイトルがリンクラベルを途中で閉じ、残りが生のテキストとして常設コメントに居座る
- 改行を含むタイトルが sticky 本文に任意の行を注入できる
- **1 行に収まった偽マーカーが有効になる。** 空白の畳み込みだけでは防げない。`<!-- review-bot:v1 run ... -->` をタイトルに書かれると `parseRunMarkers` が拾い、履歴と累計コストが汚染される。`<` と `>` を実体参照にすればコメント区切りが成立しなくなり、表示は変わらない（sticky マーカーの偽装は末尾一致で既に無効化されている）

無害化は描画側（`render.ts`）に置き、`parseFindings` のスキーマ境界は触らない。指摘 body やインラインコメント側は Markdown のリンク構文に埋めないため対象外。

## 4. モジュール構成

| ファイル               | 変更                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/core/marker.ts`   | sticky / run マーカーの build・parse、タイトル抽出を追加。`SUMMARY_MARKER`・`FAILURE_MARKER` を削除                  |
| `src/core/board.ts`    | **新規**。スレッド一覧を `{ outstanding, resolved }` に整理する純関数                                                |
| `src/core/render.ts`   | `renderSummary` / `renderFailureSummary` を `renderSticky` に統合。`renderInlineComment` は据え置き                  |
| `src/core/decision.ts` | `ReviewEvent` に `APPROVE` と `NONE` を追加                                                                          |
| `src/core/i18n.ts`     | 新しい文言に差し替え                                                                                                 |
| `src/io/github.ts`     | GraphQL に `path` / `line` / `url` / `body` を追加。sticky の find・upsert、`dismissReview`、`listOwnReviews` を追加 |
| `src/config.ts`        | `approve`（boolean、既定 `false`）を追加                                                                             |
| `src/core/prompt.ts`   | 「差分に含まれるファイル以外を指摘対象にしない」を明示                                                               |
| `src/io/agent.ts`      | `AgentOutcome` に実行メトリクスを追加                                                                                |
| `src/orchestrate.ts`   | フロー全体。attempt ごとのメトリクスを合算する                                                                       |
| `action.yml`           | `approve` input と 2 つの output を追加                                                                              |

**outputs**。既存の `findings-count` などは今回の新規分を表す意味のまま変えない。累計コストを workflow 側から使えるよう、次の 2 つだけ追加する。

| output           | 内容                                        |
| ---------------- | ------------------------------------------- |
| `cost-usd`       | この実行のコスト（全 attempt 合計）         |
| `total-cost-usd` | PR 全体の累計コスト（`run` マーカーの合計） |

未解決総数の output 追加はスコープに含めない。

`dedupe.ts` の `ExistingFinding` は `ThreadInfo` に包含されるため、`dedupe()` は `ThreadInfo[]` をそのまま受け取れる。`ExistingFinding` 型は削除して `dedupe()` のシグネチャを構造的部分型で受ける形に寄せる。

`board.ts` を独立させる理由は、「PR 全体の指摘の現在状態を組み立てる」ことが `render`（表示）とも `dedupe`（投稿対象の選別）とも別の関心だから。入力は GitHub のスレッド配列だけ、出力は表示順に並んだ配列だけで、単体でテストできる。

### `src/core/board.ts` のインターフェース

```ts
export interface ThreadInfo {
	key: string;
	severity: Severity;
	title: string | null; // パース失敗時は null
	file: string;
	line: number | null;
	url: string;
	isResolved: boolean;
	isOutdated: boolean;
}

export interface Board {
	outstanding: ThreadInfo[]; // severity 昇順、同順位は file:line 順
	resolved: ThreadInfo[]; // 同上
	counts: Record<Severity, number>; // outstanding のみ
}

export function buildBoard(threads: readonly ThreadInfo[]): Board;
```

### `src/io/github.ts` の追加メソッド

```ts
findSticky(): Promise<{ commentId: number; body: string } | null>;
upsertSticky(input: { commentId: number | null; body: string }): Promise<void>;
listThreads(): Promise<ThreadInfo[]>;              // listExistingFindings を置き換え
createReview(input: CreateReviewInput): Promise<void>;
dismissOwnApproval(message: string): Promise<void>;
```

`findSticky` は `issues.listComments` をページングし、`sticky` マーカーを持つ最初のコメントを返す。長い PR で取りこぼさないためページングは必須。

`dismissOwnApproval` は `pulls.listReviews` から自分の最新 `APPROVED` を探し、あれば `pulls.dismissReview` を呼ぶ。

### `src/io/agent.ts` の実行メトリクス

現状 `runAgent` は `result` メッセージを `JSON.stringify` してログに流すだけで、コストを呼び出し側に返していない（`src/io/agent.ts:133`）。ここから `total_cost_usd` / `duration_ms` を拾って返す。

```ts
export interface AgentMetrics {
	costUsd: number;
	durationMs: number;
}

export type AgentOutcome =
	| { ok: true; findings: Finding[]; metrics: AgentMetrics }
	| { ok: false; error: string; metrics: AgentMetrics };
```

**失敗時もメトリクスを返す。** タイムアウトや予算超過は、そこまでに使ったぶんを消費済みだから。ただし `result` メッセージが届く前に abort された場合や、SDK が例外を投げた場合は値が取れない。そのときは `costUsd: 0` を返す。**これは「コストがかからなかった」ではなく「計測できなかった」を意味する** — 累計は下振れしうる。過大に見積もって PR に嘘の数字を出すよりは、取れたぶんだけを積む方を選ぶ。

`orchestrate` は attempt ごとの `metrics` を合算し、`run` マーカーの `cost` / `sec` / `attempts` に書く。

## 5. データフロー

```
1  PR 取得 / fork チェック                            ← 現状のまま
2  sticky コメントを探す
3  起点 = mode=full ? baseSha : (sticky.reviewed ?? baseSha)
4  diff 取得 → analyzeDiff
5  差分ゼロ → sticky を再描画（reviewed を head へ）して終了
6  エージェント実行（リトライ込み）
7  失敗 → スレッド取得 → board 組み立て → sticky に失敗バナー付きで更新
        / run マーカーを event=FAILED で追記（コストは発生しているため）
        / 自分の APPROVE があれば dismiss / reviewed は据え置き
        / RunResult は failed
8  スレッド取得 → dedupe
9  行が差分内 → インラインコメント / それ以外 → ファイル単位コメント
10 decideEvent
11 event ≠ NONE または インラインあり → createReview
12 スレッドを再取得（新規コメントの URL を得るため）
13 board 組み立て + run マーカー追記 → sticky を upsert（reviewed=headSha）
14 outputs
```

**ステップ 12 について。** GraphQL を 1 回余分に叩くが、代わりに **サマリーは常に「GitHub の現状」から組み立てられる**。投稿前の予測値と投稿後の実態がずれる余地が消え、board を組み立てるコードが 1 本で済む。この 1 リクエストは払う価値がある。

**ステップ 9 について。** 行を特定できなかった指摘という**カテゴリを廃止する**。行が差分内に無い場合は `subject_type: file` のファイル単位レビューコメントにフォールバックさせる。スレッドが立つので board の索引に載り、URL も持つ。

差分に含まれないファイルへの指摘だけが真に投稿できないケースとして残るが、これは `src/core/prompt.ts` で「差分に含まれるファイル以外を指摘対象にしない」と明示することで防ぐ。それでも出てきた場合は破棄し、ログに残す。

**検証済み（Task 6）**: `node_modules/@octokit/openapi-types/types.d.ts` の `"pulls/create-review"` オペレーション定義（`requestBody.content["application/json"].comments[]`）を直接確認したところ、フィールドは `path` / `position` / `body` / `line` / `side` / `start_line` / `start_side` のみで `subject_type` は無い。`subject_type` が出現する箇所は `"pulls/create-review-comment"` のリクエストボディと、レスポンス用の `pull-request-review-comment` スキーマ・webhook ペイロードのみ（`grep -n "subject_type"` はヒットするが、いずれも create-review の request body ではない）。よって `createReview` は Review 本体を `pulls.createReview`（インラインコメントのみ）で投稿したあと、ファイル単位コメントを `pulls.createReviewComment`（`subject_type: 'file'`）で個別に投稿する実装を採用した（`src/io/github.ts`）。スレッドは同様に立つため機能への影響はなく、API 呼び出し回数が増えるだけ。

## 6. APPROVE の設計

`approve` input（boolean、既定 `false`）。有効かつ **PR 全体の未解決指摘が 0 件**のときだけ `APPROVE` を提出する。

**opt-in にする理由。** GITHUB_TOKEN による approve はブランチ保護の「必要な承認数」を満たしうる。severity はモデル出力から決まり、モデル出力は差分の内容に影響されうるため、既定で有効にすると差分経由で承認を取る経路ができる。既定 off なら、有効にした人が明示的にその判断をしたことになる。

**`decideEvent` の新しい仕様。**

**「未解決 0 件」の判定タイミング。** `decideEvent` はステップ 10、つまり board を組み立てるステップ 12 より前に呼ばれる。したがって未解決件数はステップ 8 で取得した既存スレッドから直接計算する。

```
投稿後の未解決件数 = 既存スレッドのうち !isResolved の数 + 今回投稿する指摘の数
```

ステップ 12 で再取得した board の `counts` とこの値は一致するはずだが、`decideEvent` はそれを待たない。両者がずれるのは、レビュー実行中に人がスレッドを resolve した場合だけで、そのときは次回の実行で収束する。

```
canRequestChanges = PR 作者が bot でない
                    （bot 作成 PR に REQUEST_CHANGES を出すと 422）

approve 有効 かつ 投稿後の未解決 0 件               → APPROVE
threshold ≠ none かつ canRequestChanges かつ
  （新規指摘に閾値以上がある または 未解決に閾値以上がある） → REQUEST_CHANGES
新規インラインコメントがある                        → COMMENT
それ以外                                          → NONE（Review を作らない）
```

`NONE` のとき `createReview` を呼ばないことで、指摘ゼロの push では sticky が静かに更新されるだけになる。Conversation タブが `reviewed` エントリで埋まる問題が根本的に消える。

**REQUEST_CHANGES の解除。** GitHub は同一レビュアーの最新レビュー状態を採用するため、`REQUEST_CHANGES` 後に未解決が 0 になれば `APPROVE` を出すだけで解除される。`dismissReview` は不要。

**失敗時の APPROVE 取り下げ。** APPROVE を出した後にレビューが失敗すると、古い APPROVE が残ったまま PR が緑に見える。これは `fail-on-error` が防ごうとしている状況そのものなので、失敗パス（ステップ 7）で自分の APPROVE を `pulls.dismissReview` で取り下げる。

## 7. 手動 resolve と outdated の扱い

**再投稿しない（変更なし）。** `dedupe` は key が既存スレッドにあれば resolved かどうかに関わらず投稿しない（`src/core/dedupe.ts:29`）。人が resolve した判断を蒸し返さないという既存の挙動を維持する。

**board では「解決済み」に畳む。**

**APPROVE 判定では resolve を「対応済みの意思表示」とみなす。** 誰が resolve したかは問わない。

この決定には既知の抜け穴がある。PR 作者が自分で全スレッドを resolve すれば bot の承認が取れるため、`approve` を有効にした上でブランチ保護の必要承認数を bot の承認で満たしている構成では、自己承認の経路になる。

それでもこの扱いを選ぶ理由は 2 つ。第一に、GitHub 自身が「Require conversation resolution before merging」で resolve をマージ条件として扱っており、resolve を意思表示とみなす解釈は GitHub の設計と整合する。第二に、`resolvedBy` を見て PR 作者による resolve を除外する案は、実務では指摘を直して resolve するのがたいてい作者本人であるため、APPROVE がほぼ発火せず機能として死ぬ。

防御は `approve` が opt-in であることと、README での明記に置く。README に「**bot の承認は人間のレビューの代替ではなく、ブランチ保護の根拠にしてはならない**」と書く。

**`isOutdated` かつ未解決は、未解決として数える。** board の行に `(outdated)` を付す。outdated を解決済み扱いにすると、指摘箇所を書き換えるだけで指摘を消せてしまう。現行の `decideEvent` も `!isResolved` しか見ていないので挙動は変わらない。

## 8. エラー処理

| 事象                           | 挙動                                                                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sticky の upsert 失敗          | ログに残して続行。レビュー自体は成功しているので落とさない。`reviewed` が進まないため次回同じ範囲を再レビューするが、`dedupe` により二重投稿はしない（安全側に倒れる） |
| sticky を人が削除した          | 次回新規作成。履歴は失われるがログに残す。`reviewed` も失われるため 1 回だけ全差分レビューになる                                                                       |
| fork PR                        | 現状のまま。`createReview` も `createComment` も試みずに abort                                                                                                         |
| エージェント失敗               | sticky に失敗バナー / `run` マーカーを `FAILED` で追記 / `reviewed` 据え置き / 自分の APPROVE を dismiss / `fail-on-error` に従う                                      |
| ファイル単位コメントの投稿失敗 | その指摘は board に載らない。ログに残し、レビュー全体は成功扱いとする                                                                                                  |
| 実行メトリクスを取得できない   | `costUsd: 0` として記録し、累計は下振れする。過大な数字を出すよりは良いと判断する                                                                                      |
| `run` マーカーのパース失敗     | その 1 行を無視して続行。履歴が 1 行減り累計が下振れするだけで、他の行は読める                                                                                         |
| `findSticky` 自体が失敗した    | sticky を**書かない**。既存コメントの id が分からない状態で新規作成すると sticky が二重になり、以後どちらが正かを決められなくなる。ログにのみ残す                      |
| その他の想定外の例外           | エージェント失敗と同じ経路に合流させ、バナーと `FAILED` の run マーカーを残す。握らずに抜けると sticky に痕跡が残らない                                                |

### 受容した残存リスク

`findSticky` は sticky コメントの作成者を確認するが、`GITHUB_TOKEN` はインストールトークンで `GET /user` が使えないため、そのときは `user.type === 'Bot'` までしか絞れない。

したがって、**同じリポジトリに入っている別の GitHub App が PR 由来のテキストをそのままコメントに出力する場合**、そこに偽の sticky マーカーを仕込まれると `reviewed` を head まで進められ、次の実行が空差分になってレビューが素通りする。人間（`type: 'User'`）による偽装は塞がれている。

`anthropic-api-key` や PAT を使う構成では `GET /user` が通るのでログイン一致まで確認でき、この経路は塞がる。受容する理由は、`GITHUB_TOKEN` で自分の identity を確定する API が存在しないこと、および攻撃には「PR 由来テキストを echo する別 App が同居している」という条件が要ることによる。

## 9. テスト計画

既存の純関数中心の方針を踏襲する。

**`tests/core/marker.test.ts`**

- sticky マーカーの build → parse 往復
- run マーカーの build → parse 往復、複数行の順序保持
- run マーカーの**未知キーを無視する**
- run マーカーの**欠損キーが既定値で埋まる**（`cost=0` / `attempts=1` など）— 拡張前の古いマーカーが読めること
- run マーカーの値が `[\w.:@/-]+` から外れた場合に欠損扱いになる
- `run` マーカー群からの累計コスト算出（`FAILED` 行も合算されること）
- インラインコメント本文からのタイトル抽出
- 指摘 body に偽マーカーが混ざった場合に末尾の正規ブロックが勝つ（既存テストの維持）
- タイトル書式が壊れている場合に `null` を返す

**`tests/core/board.test.ts`（新規）**

- 未解決 / 解決済みの振り分け
- severity 昇順、同順位は `file:line` 順のソート
- `isOutdated` かつ未解決が outstanding に入る
- タイトル `null` のフォールバック
- `counts` が outstanding のみを数える

**`tests/core/render.test.ts`**

- 未解決あり / 未解決ゼロ / 失敗バナーあり / 履歴あり の各形
- 解決済みが `<details>` に入り、`### 未解決の指摘` は入らない
- `(outdated)` の付与
- 履歴テーブルのコスト列と `<summary>` の累計が一致する
- `FAILED` 行の判定列が `⚠️ 失敗`、`NONE` 行が `—` になる
- sticky マーカーと run マーカーが末尾に出力される
- `en` / `ja` 両方

**`tests/core/decision.test.ts`**

- `approve` off のとき未解決 0 でも APPROVE しない
- `approve` on かつ未解決 0 で APPROVE
- `approve` on でも未解決があれば APPROVE しない
- bot 作成 PR で REQUEST_CHANGES にならない
- 新規指摘もイベント変化もないとき `NONE`

**`tests/orchestrate.test.ts`**

- 指摘ゼロなら `createReview` を呼ばず sticky だけ更新する
- 失敗時に `reviewed` が進まない
- 失敗時に `run` マーカーが `event=FAILED` で追記され、コストが累計に乗る
- 失敗時に自分の APPROVE を dismiss する
- リトライした場合に全 attempt の `costUsd` / `durationMs` が合算され、`attempts` に回数が入る
- sticky が無い PR で `baseSha` を起点にする
- sticky の upsert が失敗してもレビュー全体は成功扱いになる

## 10. README への変更

- `approve` input を Inputs 表に追加
- `cost-usd` / `total-cost-usd` を Outputs 表に追加
- `max-cost-usd` の説明に「**エージェント 1 回あたり**の上限であり、`max-retries` 回ぶん積み上がりうる」ことを補足する。sticky に累計が出るようになると、この差が目に見えるようになるため
- 「bot の承認は人間のレビューの代替ではなく、ブランチ保護の根拠にしてはならない」節を追加。`request-changes-on` の同種の記述と並べる
- 「The state lives in the review threads on GitHub. There is no database, no hidden state block, no display IDs.」を実態に合わせて書き直す。状態は sticky コメントのマーカーと review スレッドに分散して置かれる
- 「Not supported」から `suggestion` 以外の記述を見直す
- Incremental reviews の節を、起点が sticky から読まれる形に更新
- Fail-closed behaviour の節を、失敗通知が sticky のバナーになる形に更新

## 11. 移行

v1 の PR には sticky コメントが無いため、新バージョンでの初回実行は `baseSha` からの全差分レビューになる。ただし `dedupe` が既存スレッドと突き合わせるため二重投稿は起きず、余計にかかるのは 1 回分の実行コストだけ。互換シムは入れない。

`SUMMARY_MARKER` / `FAILURE_MARKER` の削除により、v1 が投稿した Review は新バージョンから見て意味を持たなくなるが、実害はない。

メジャーバージョンを上げて `v2` タグを切る。

## 12. 今回やらないこと（バックログ）

ブレストで挙がったが、このスコープには入れない。

- `suggestion` ブロック（ワンクリック適用）
- 指摘のカテゴリタグ（security / correctness / perf / maintainability / test）とサマリーでの分類
- 未解決指摘の再検証（現行コードで直っていれば自動 resolve）
- 誤検知の明示的な抑制（`review-bot-ignore` 等）
- 大きい PR の分割レビュー（`diff-max-bytes` での切り捨ての代替）
- fork PR 対応（`workflow_run` パターン）
- `language` の `en` / `ja` 固定を外す
