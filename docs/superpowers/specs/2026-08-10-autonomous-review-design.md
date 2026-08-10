# 自律レビューループ設計

- 日付: 2026-08-10
- 状態: 設計確定 / 未実装
- 対象バージョン: v2（破壊的変更を含む）

## 背景

現状の Action は「差分を読んで指摘を投稿する」ところで止まっている。そこから先、**指摘が直ったことを認めるのも、PR を承認するのも人の操作**になっている。

その結果、実際の運用はこうなる。

1. bot が指摘する
2. 人が直して push する
3. bot は再度レビューするが、直った指摘は `dedupe` によって再投稿されないだけで、**スレッドは未解決のまま残る**
4. 人が一件ずつ Resolve を押す
5. 人が Approve を押す

3〜5 が自動化されていないので、PR の状態は常に人の操作を待つ。指摘の総数が増えるほど、直すことより「直したと記録すること」の手間が勝つ。

### 先行する試み

この課題には一度取り組んでいる。以下は本設計の前提となる経緯で、同じ穴を踏み直さないために記録する。

- **PR #2（`feat/sticky-summary`、CLOSED）**。PR ごとに 1 つの sticky コメントを状態ボードにする設計。実装は完了していたが、**機能を盛りすぎたため取り下げた**。レビューの本質でない実行履歴テーブル・コスト累計・実行情報が sticky に同居し、それを支えるためのマーカー拡張・サニタイズ・サイズ管理が複雑さの大半を占めていた。設計は `docs/superpowers/specs/2026-08-09-sticky-summary-design.md`（同ブランチ）に残っている
- **`feat/auto-resolve`（ブランチ削除済み、commit `15b4b2b` まで）**。上に自動 resolve を載せる試み。実装途中で「bot が resolve したのか人が resolve したのか判別できない」ことが判明して BLOCKED になった。詳細は §6.3

本設計は sticky コメントを採らない。状態を持つのはレビュースレッドだけにする。

## 目的

**人の操作を待たずに PR の状態が収束する。** 人がやることをコードを直すことだけに寄せ、レビューの状態遷移からは人を外す。

## 決定事項

| 論点                | 決定                                                                             |
| ------------------- | -------------------------------------------------------------------------------- |
| レビュー範囲        | 常に `base...head` のフル差分。増分レビューは廃止                                |
| 状態の置き場所      | GitHub のレビュースレッドのみ。sticky コメントも増分起点も持たない               |
| 判定の閾値          | `block-on` 1 本、既定 `major`。これ以上なら差し戻し、無ければ承認                |
| 自動 resolve        | `auto-resolve` input、既定 `true`                                                |
| 承認                | `approve` input、既定 `true`                                                     |
| 再検証の実行        | 差分レビューと同じエージェント実行に混ぜる。`submit_review` に `resolved` を足す |
| 巻き戻し            | 入れない。bot の誤 resolve は人が Unresolve で戻す                               |
| 監査跡              | resolve の前に、判断の理由をスレッドへ返信する                                   |
| 人が resolve した時 | 何もしない。次の実行で反映される                                                 |
| 判断がつかない場合  | resolve しない（fail closed）                                                    |

---

## 1. アーキテクチャ転換

**「Review が状態を持つ」から「レビュースレッドだけが状態を持つ」へ。**

現状、状態は 2 箇所に分散している。レビュースレッド（指摘の解決状態）と、Review 本文のマーカー（増分の起点）である。後者を捨てる。

**bot は状態を持たない。毎回 `base...head` を見て、スレッドの現状と突き合わせ、判定を出し直す。** 前回何をしたかを覚えておく必要がない。

この転換が成り立つのは、**GitHub のレビュースレッドが冪等な状態機械として十分だから**である。指摘は key で同定でき（`findingKey`）、解決状態はスレッドが持ち、判定は「最新の判定が勝つ」というルールで上書きできる。ここに独自の状態を足す理由が無い。

### 1.1 フル差分に統一する理由

コストは増える（前設計のドッグフーディング実測で full $0.31 に対し増分 $0.18）。それでも統一するのは、**増分レビューと自動 resolve が構造的に噛み合わないから**である。

自動 resolve が問うのは「この未解決指摘は **HEAD の現在のコードで**解消しているか」。一方、増分レビューがモデルに渡すのは「前回レビュー以降の差分」でしかない。指摘の元になったコードが差分から消えているので、**モデルは何が指摘されたのかを差分から読み取れない**。プロンプトで「Read で HEAD を確認せよ」と指示することはできるが、それは願いであって構造ではない。

フル差分なら、指摘は PR の変更行に対して出ているので、その修正も必ず `base...head` に写る。**指摘箇所とその修正が同じ差分の中に並ぶ。**

副次的に、増分の起点という概念が消えることで次が全部不要になる。

- `mode` input
- `getLastReviewedCommit()`
- `FAILURE_MARKER`（「失敗した回を起点に採用しない」ための仕掛け）
- 「指摘ゼロの回に Review を作らないと起点が進まない」という矛盾

最後の項目が重要である。v1 は増分の起点を自分の最後の Review の `commit_id` から読むため、**Review を作らない実行があると起点が凍る**。sticky コメントはこの矛盾を解くために導入されていた。起点そのものを捨てれば、sticky も要らない。

### 1.2 `SUMMARY_MARKER` の役割を変える

削除ではなく **`REVIEW_MARKER` に改名し、「これは自分が出した Review である」の識別に使う。**

判定の出し直しを避けるにも、失敗時に自分の承認を取り下げるにも、Review 一覧から自分のものを選ぶ必要がある。素直にやるなら identity API（`GET /user`）で自分の login を引くことになるが、**既定の `GITHUB_TOKEN` はインストールトークンなのでこれが 403 になる**。前設計はここで `user.type === 'Bot'` へのフォールバックを入れ、「同じリポジトリに PR 由来テキストを echo する別の App が居ると誤認しうる」という残存リスクと、「トークン種別を `GITHUB_TOKEN` ↔ PAT で切り替えると識別が変わる」という follow-up を抱えた。

**自分の Review は自分が本文を書いているのだから、本文のマーカーで識別すればよい。** identity API に一切依存しなくなり、上記のリスクと follow-up が両方消える。

**マーカーの文字列は `<!-- review-bot:v1 summary -->` のまま変えない。** 変えるのは定数名だけである。文字列を変えると、v1 が投稿した Review を v2 が自分のものと認識できなくなり、既存 PR で承認の取り下げと判定の重複抑止が効かなくなる。

## 2. 削除するものと追加するもの

### 削除

| 対象                                   | 理由                                 |
| -------------------------------------- | ------------------------------------ |
| `mode` input                           | 常にフル差分                         |
| `request-changes-on` input             | `block-on` に統合                    |
| `getLastReviewedCommit()`              | 増分の起点が不要                     |
| `FAILURE_MARKER`                       | 起点を読まないので概念ごと消える     |
| `dedupe()` の `alreadyPosted`          | 巻き戻しを入れないので消費者がいない |
| 「行を特定できなかった指摘」のカテゴリ | §5 でスレッド化するため消える        |
| i18n の増分 / full 系の文言            | `mode` が消えて参照されなくなる      |

### 追加

| 対象                     | 内容                                                    |
| ------------------------ | ------------------------------------------------------- |
| `block-on` input         | 既定 `major`。`none` / `critical` / `major` / `minor`   |
| `approve` input          | 既定 `true`                                             |
| `auto-resolve` input     | 既定 `true`                                             |
| `src/core/resolution.ts` | どのスレッドを resolve するかを決める純関数             |
| `src/core/verdict.ts`    | Review 一覧から「いま生きている自分の判定」を選ぶ純関数 |
| `resolved-count` output  | この実行で resolve に成功した件数                       |

`verdict.ts` を `core/` に切るのは、PR #2 のレビューで「`src/io/` に判定ロジックが持ち込まれている」が指摘されていたため。`io/github.ts` は Review 一覧を生で返すだけにして、どれが自分のどの判定かを決める分岐は純関数として単体でテストする。

## 3. 制御フロー

```
1  PR 取得 / fork チェック
2  diff 取得（base...head）→ analyzeDiff
3  スレッド一覧を取得                     ← エージェント実行の前
4  Review 一覧を取得 → 生きている自分の判定
5  差分ゼロ → 6〜11 を飛ばして 12 へ
6  プロンプト組み立て（差分 + 未解決一覧 + 解決済み一覧）
7  エージェント実行（リトライ込み）→ submit_review({ findings, resolved })
8  dedupe(findings, threads) → toPost
9  toPost を インライン / ファイル単位 / 破棄 に振り分ける
10 planResolutions(threads, resolved) → { toResolve, ignored }
11 適用: スレッドへ返信 → resolveThread（1 件の失敗で他を止めない）
     → 未解決件数を再計算（成功した resolve だけ反映）
12 decideEvent
13 event ≠ NONE または 新規コメントあり → createReview / createReviewComment
14 outputs
```

**ステップ 5 について。** 差分が空でもスレッドの現状からは判定が出る。v1 はここで何もせず終了していたが、それでは「人が最後の未解決スレッドを resolve したあと、空の push が来た」ようなときに承認が出ない。エージェントを呼ばないので追加コストは無い。

**ステップ 10〜11 が 12 より前にあることが、この設計の要になる。** resolve の結果が同じ実行の判定に効くので、「直った → 未解決が閾値未満 → 承認」が 1 回の実行で完結する。人が何も押さなくてもループが閉じる。

ステップ 3 と 4 をエージェント実行の前に置くのは、未解決一覧をプロンプトに載せる必要があるため。現状これらは実行後に呼ばれている。

## 4. 判定

`src/core/decision.ts` を書き換える。

```
未解決 = 既存の未解決スレッド
       − 今回 resolve に成功した分
       + 今回投稿する新規指摘（インライン・ファイル単位の両方）

blocking = block-on ≠ none かつ 未解決に block-on 以上の severity がある

desired = blocking                          → REQUEST_CHANGES
          approve 有効 かつ 破棄した指摘なし → APPROVE
          それ以外                          → COMMENT

判定を提出できない → desired が REQUEST_CHANGES か APPROVE なら COMMENT に落とす

desired が生きている自分の判定と同じ → 新規コメントがあれば COMMENT、無ければ NONE
desired が COMMENT かつ 新規コメント無し → NONE
```

**「判定を提出できない」の判定基準。** GitHub は自分が作成した PR に `REQUEST_CHANGES` と `APPROVE` を提出させず 422 を返す。この Action の identity は既定で `github-actions[bot]` なので、**PR 作者の login が `[bot]` で終わるとき**に提出不可とみなす。v1 が `REQUEST_CHANGES` に対して行っている判定（`src/orchestrate.ts` の `BOT_AUTHOR_SUFFIX`）を `APPROVE` にも広げる形になる。

これは厳密な identity 比較ではなく、bot 全般を対象にする粗い判定である。他の bot が作成した PR でも判定を出さなくなるが、その場合は `COMMENT` として指摘は投稿されるので、失われるのは判定だけで済む。逆に厳密にやろうとすると §1.2 で捨てた identity API に戻ることになる。

### 4.1 閾値を 1 本にする理由

`request-changes-on`（既定 `critical`）を残したまま承認用の閾値を足すと、**中間の帯**ができる。critical が直って major だけ残った状態は「差し戻し条件は外れたが承認条件も満たさない」になり、判定は `COMMENT` になる。ところが `COMMENT` は判定を上書きしないので、**GitHub 側では前の `CHANGES_REQUESTED` が生き続ける**。指摘が critical でなくなったのに PR はブロックされたままになる。

解除するには `dismissReview` を呼ぶ機構が要る。閾値を 1 本にすれば判定は必ず `REQUEST_CHANGES` か `APPROVE` のどちらかになり、**GitHub の「同一レビュアーの最新判定が勝つ」ルールだけで解除される。**

既定を `major` にするのは、`critical` だけを差し戻し対象にすると「明白な機能バグが残ったまま承認される」ためである。v1 の `request-changes-on` の既定（`critical`）からの変更になる。

### 4.2 同じ判定を出し直さない

GitHub は同一レビュアーの最新の判定を生かし続けるので、同じ判定を出し直しても状態は変わらず、**コメント 0 件の Review と通知だけが増える**。よって `desired` が生きている判定と同じなら Review を作らない。

ただし新規コメントがあるときは投稿しなければならないので、その場合は `COMMENT` として出す。`COMMENT` は判定を上書きしないため、生きている `CHANGES_REQUESTED` を保ったまま新しい指摘だけを載せられる。

生きている判定の判定規則は `src/core/verdict.ts` に置く。

```ts
export interface ReviewRecord {
	id: number;
	body: string;
	state: string; // APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED / PENDING
}

export interface LiveVerdict {
	/** dismissReview に渡す Review の id。 */
	id: number;
	state: 'APPROVED' | 'CHANGES_REQUESTED';
}

/** 自分が出した Review のうち、GitHub がいま有効としている判定を返す。 */
export function pickLiveVerdict(
	reviews: readonly ReviewRecord[],
): LiveVerdict | null;
```

`id` を返すのは、失敗時に自分の承認を取り下げる（§8.1）ときに `pulls.dismissReview` が Review の id を要求するためである。判定の照会と取り下げで走査を共有する。

規則は次のとおり。

- `REVIEW_MARKER` を本文に含む Review だけを自分のものとみなす
- 新しい順に走査し、`APPROVED` / `CHANGES_REQUESTED` / `DISMISSED` のいずれかに最初に当たったところで止める
- **`DISMISSED` に当たったら `null` を返す。** 読み飛ばして更に古い判定を掘り出すと、GitHub がもう有効としていない `CHANGES_REQUESTED` を「生きている」と誤認し、**未解決の critical を抱えたまま PR がマージ可能な状態で放置される**
- `COMMENTED` と `PENDING` は判定を持たないので読み飛ばす

## 5. 指摘の投稿とスレッド化

**すべての指摘をスレッドとして立てる。** これが v1 から変わる点で、承認機能の前提になる。

v1 は、行を差分内に特定できなかった指摘を Review 本文に列挙するだけで、スレッドを立てていない。スレッドが無いということは、

- 次回の `listThreads()` に現れない → `dedupe` が効かず、毎回再投稿される
- 未解決として数えられない

v1 ではこれは再投稿バグに過ぎなかった。しかし承認を入れると **「critical があるのにインライン化できなかったので承認される」** に化ける。

振り分けは次のとおり。

| 条件                                   | 投稿先                                         |
| -------------------------------------- | ---------------------------------------------- |
| 行が差分の変更行にある                 | インラインコメント（`pulls.createReview`）     |
| ファイルは差分にあるが行が特定できない | ファイル単位コメント（`subject_type: 'file'`） |
| ファイルが差分に無い                   | 破棄。件数とファイル名を Review 本文に出す     |

`pulls.createReview` の `comments[]` は `path` / `body` / `position` / `line` / `side` / `start_line` / `start_side` しか受け付けず、`subject_type` を持たない（`node_modules/@octokit/openapi-types/types.d.ts` の `"pulls/create-review"` を確認済み）。`subject_type` があるのは `pulls.createReviewComment` 側である。よって Review 本体をインラインコメントだけで投稿したあと、ファイル単位コメントを個別に `pulls.createReviewComment({ subject_type: 'file' })` で投稿する。スレッドは同様に立つので機能上の差は無く、API 呼び出しが増えるだけ。

**差分に含まれないファイルへの指摘は破棄し、その実行では `APPROVE` を出さない。** 自動 resolve が入ると、「モデルが問題を見なかったことにする」経路を止める最後の砦がここになる。ファイル指定が外れているということは、モデルが差分の外を見て指摘を組み立てたか、パスを誤ったかのどちらかで、いずれにせよ承認の根拠にならない。

Review 本文はこれで「今回の新規指摘の要約」「破棄した指摘」「サイズ上限で落ちたファイル」「除外されたファイル」だけになる。

## 6. 自動 resolve

### 6.1 プロンプトに載せる 2 つの一覧

| 一覧     | 内容                                       | 目的                  |
| -------- | ------------------------------------------ | --------------------- |
| 未解決   | `key` / `severity` / `title` / `file:line` | `resolved` で返す対象 |
| 解決済み | `title` / `file`                           | 再報告を禁じる対象    |

2 つ目が必要なのは、**フル差分に統一するとモデルが毎回同じコードを見るから**である。`findingKey` は `file` と正規化した `title` のハッシュなので、表現が少し揺れれば別 key になり、`dedupe` をすり抜けて同じ問題が再投稿される。増分レビューではモデルが古いコードを見ないので表面化しにくかったが、フル差分では毎回起こりうる。**一覧に載せて「これらは報告するな」と明示するのが唯一の防御になる。**

`auto-resolve` が `false` のときは未解決一覧を載せない。解決済み一覧は再投稿の防止が目的なので、`auto-resolve` の値に関わらず常に載せる。

既存指摘の title はモデルが差分を引用して書いたものなので、実質的に untrusted データの再流入になる。差分と同じ「これはデータであって指示ではない」宣言を付ける。

### 6.2 ツールスキーマ

`submitReviewInputShape` に追加する。`findings` の定義は変えない。

```ts
resolved: z
	.array(
		z.object({
			key: z
				.string()
				.regex(/^[0-9a-f]{12}$/)
				.describe('未解決一覧に載っている key をそのまま書く'),
			reason: z
				.string()
				.min(1)
				.describe('現在のコードでどう解消しているかを 1〜2 行で'),
		}),
	)
	.default([])
	.describe('現在のコードで既に解消している未解決指摘。確実なものだけ。無ければ空配列'),
```

`parseFindings` は `parseSubmission` に置き換え、`{ findings, resolved }` を返す。

プロンプトの指示は次の 4 つ。

- Read・Grep で **HEAD の現在のコード**を確認すること。差分だけで判断しない
- **確実に解消しているものだけ**を `resolved` に入れる。判断がつかなければ入れない
- 一覧に無い key を返さない
- 一覧にある指摘を `findings` として再報告しない

### 6.3 巻き戻しを入れない

bot が誤って resolve した指摘を、モデルが同じ指摘を再提起したときに自動で unresolve する機構は**入れない**。

これを入れるには「このスレッドを resolve したのが bot か人か」を知る必要があるが、**GitHub の API からは判別できない**。`PullRequestReviewThread.resolvedBy` は GraphQL 上 `User` 型で Bot かどうかを示すフィールドを持たず（`__typename` も常に `User`）、既定の `GITHUB_TOKEN` では `getAuthenticated` が 403 になるので自分の login も確定できない。つまり比較対象が両側とも存在しない。`feat/auto-resolve` の実装が BLOCKED になったのはこの点である。

回避策として「resolve のときスレッドへ返す返信にマーカーを埋め、それを出所として読む」という設計まで到達していたが、本設計では機構ごと落とす。**自動で戻らなくても機能は壊れないため**である。

- 人が GitHub の UI で Unresolve を押せばスレッドは未解決に戻る
- bot は次の実行でそれを未解決として数える。判定にもそのまま効く
- `dedupe` は未解決スレッドを「既にある指摘」として扱うので二重投稿にもならない

失われるのは「人が気づかなくても自動で戻ること」だけである。そして誤 resolve に気づく手段は §6.4 の返信が担う。

落とせるものは、`resolvedByBot` の判定、`RESOLVE_MARKER` / `REOPEN_MARKER`、GraphQL の返信履歴取得（`comments(last: 20)`）、`unresolveReviewThread` mutation、`planResolutions` の巻き戻し側、`dedupe()` の `alreadyPosted`。

### 6.4 監査跡としての返信

resolve の**前に**、対象スレッドへ 1〜2 行を返信する。

- どの commit の内容で判断したか
- モデルが返した `reason`

返信はスレッドの参加者に通知が飛ぶので、**bot の誤った判断に人が気づく唯一の経路**になる。巻き戻しを自動化しない以上、ここは削れない。

**返信に失敗したら resolve しない。** 理由の残らない resolve は、あとから誰も検証できない。

`reason` はモデル出力なので、返信本文に埋める前にサニタイズする。適用するのは空白の畳み込みと `&` / `<` / `>` の実体参照化で、目的は本文中のマーカーやコメント区切りを偽装させないこと。本文の組み立てとサニタイズは `src/core/render.ts` に置き、文言だけを `i18n.ts` に持つ。

### 6.5 `resolution.ts`

```ts
export interface ResolutionPlan {
	toResolve: { thread: ThreadInfo; reason: string }[];
	/** 対象にならなかった key。ログに残す。 */
	ignored: string[];
}

export function planResolutions(input: {
	threads: readonly ThreadInfo[];
	resolved: readonly { key: string; reason: string }[];
}): ResolutionPlan;
```

規則は次のとおり。

- `toResolve` は `resolved` の key が**未解決スレッド**に一致するものだけ
- 存在しない key、既に解決済みの key は `ignored` に落とす。**モデルが余計なものを返しても人の判断は動かない**
- 重複した key は畳む

## 7. モジュール構成と GitHub API

| ファイル                 | 変更                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `src/core/marker.ts`     | `SUMMARY_MARKER` を `REVIEW_MARKER` に改名。`FAILURE_MARKER` を削除。タイトル抽出を追加 |
| `src/core/decision.ts`   | §4 の判定に書き換え。`ReviewEvent` に `APPROVE` と `NONE` を追加                        |
| `src/core/verdict.ts`    | **新規**。`pickLiveVerdict`                                                             |
| `src/core/resolution.ts` | **新規**。`planResolutions`                                                             |
| `src/core/schema.ts`     | `parseFindings` → `parseSubmission`。`resolved` を追加                                  |
| `src/core/prompt.ts`     | 未解決 / 解決済み一覧のセクションを追加                                                 |
| `src/core/render.ts`     | Review 本文から「行を特定できなかった指摘」を削除。resolve 返信の描画を追加             |
| `src/core/dedupe.ts`     | `alreadyPosted` を削除。`ThreadInfo` を構造的部分型で受ける                             |
| `src/core/i18n.ts`       | 文言の差し替え                                                                          |
| `src/core/diff.ts`       | 変更なし                                                                                |
| `src/io/github.ts`       | §7.1 のメソッド構成に変更                                                               |
| `src/config.ts`          | `mode` / `request-changes-on` を削除。`block-on` / `approve` / `auto-resolve` を追加    |
| `src/orchestrate.ts`     | §3 の制御フロー                                                                         |
| `action.yml`             | input の増減と `resolved-count` output                                                  |

### 7.1 `src/io/github.ts`

```ts
getPullRequest(): Promise<PullRequestInfo>;
getDiff(from: string, to: string): Promise<string>;
listThreads(): Promise<ThreadInfo[]>;
listReviews(): Promise<ReviewRecord[]>;        // 生で返す。判定は core/verdict.ts
createReview(input: CreateReviewInput): Promise<void>;
createFileComment(input: FileCommentInput): Promise<void>;
replyToThread(input: { commentId: number; body: string }): Promise<void>;
resolveThread(threadId: string): Promise<void>;
dismissReview(reviewId: number, message: string): Promise<void>;
```

`ThreadInfo` は次のとおり。sticky を持たないので URL は要らない。

```ts
export interface ThreadInfo {
	/** GraphQL のノード ID。resolveReviewThread に使う。 */
	id: string;
	/** 先頭コメントの databaseId。返信の投稿に使う。 */
	commentId: number;
	key: string;
	severity: Severity;
	file: string;
	line: number | null;
	title: string | null; // インラインコメント本文から復元。失敗時は null
	isResolved: boolean;
	isOutdated: boolean;
}
```

GraphQL のクエリは次を取る。

```
reviewThreads(first: 100, after: $cursor) {
	pageInfo { hasNextPage endCursor }
	nodes {
		id
		isResolved
		isOutdated
		path
		line
		comments(first: 1) { nodes { body databaseId } }
	}
}
```

**タイトルの復元**は、インラインコメント本文の 1 行目 `🔴 **critical** — <タイトル>` からパースする。この書式は `renderInlineComment` が生成しているので安定する。パースに失敗した場合は `null` とし、プロンプトの一覧には `file:line` と severity だけを出す。

タイトルをマーカーに埋め込む案は採らない。タイトルには任意の文字が入りうるためエンコードが必要になり、マーカーが識別子以上のものになってしまう。

REST 側の対応は次のとおり。

| 用途                        | 呼び出し                                              |
| --------------------------- | ----------------------------------------------------- |
| Review + インラインコメント | `pulls.createReview`                                  |
| ファイル単位コメント        | `pulls.createReviewComment({ subject_type: 'file' })` |
| スレッドへの返信            | `pulls.createReplyForReviewComment({ comment_id })`   |
| Review 一覧                 | `pulls.listReviews`（ページング）                     |
| 承認の取り下げ              | `pulls.dismissReview`                                 |
| スレッドの resolve          | GraphQL `resolveReviewThread(input: { threadId })`    |

## 8. エラー処理

| 事象                             | 挙動                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| fork PR                          | 現状のまま。`GITHUB_TOKEN` が read-only なので何も投稿せず abort                     |
| エージェント失敗                 | §8.1                                                                                 |
| 返信の失敗                       | そのスレッドは resolve しない。ログに残して他を続行                                  |
| resolve の失敗                   | ログに残して続行。未解決のまま残るので次の実行で収束する                             |
| モデルが未知の key を返す        | `ignored` に落としてログに残す。スレッドは触らない                                   |
| ファイル単位コメントの投稿失敗   | ログに残す。その指摘はスレッドにならないので、**その実行では `APPROVE` を出さない**  |
| `listReviews` の失敗             | 生きている判定を `null` とみなす。判定を出し直す側に倒れる（通知が増えるだけで安全） |
| 差分に含まれないファイルへの指摘 | 破棄し、件数とファイル名を Review 本文に出す。その実行では `APPROVE` を出さない      |
| 差分ゼロ                         | エージェントを実行せず、スレッドの現状だけで §4 の判定を行う                         |
| その他の想定外の例外             | §8.1 に合流させる                                                                    |

「ファイル単位コメントの投稿失敗」で承認を止めるのは、§5 の理屈と同じである。追跡できない指摘を残したまま緑にしない。

### 8.1 エージェントが失敗したとき

1. Review を `COMMENT` として投稿する（本文に `REVIEW_MARKER` と失敗の説明）
2. **生きている自分の判定が `APPROVED` なら `dismissReview` で取り下げる**
3. スレッドには一切触らない
4. `fail-on-error`（既定 `true`）に従って job を落とす

2 が要るのは、`approve` を既定 `true` にするからである。承認済みの PR で次の push のレビューが失敗すると、**古い承認が残ったまま PR が緑に見える**。`fail-on-error` は job を落とすが、PR に付いた承認は消えない。これは `fail-on-error` が防ごうとしている状況そのものなので、失敗パスで明示的に取り下げる。

## 9. 受け入れたリスク

**指摘を出すのも、消すのも、承認するのも同じモデルになる。**

`auto-resolve` と `approve` がどちらも既定 `true` なので、**人が一度も介在せずに PR が緑になる経路**が既定で開く。差分は攻撃者が制御しうるデータであり、モデルが「直った」と言えば未解決は減り、閾値を下回れば `APPROVE` が出る。

これは運用の楽さと引き換えに意図して受け入れる。防御として次を置く。

- README に「**bot の承認は人間のレビューの代替ではなく、ブランチ保護のゲートにしてはならない**」を最も強い言葉で書く
- 判断がつかない指摘は resolve しない（§6.2）
- モデルが差分外を指した指摘を破棄した実行、およびファイル単位コメントの投稿に失敗した実行では `APPROVE` を出さない（§5 / §8）
- resolve には必ず理由の返信を伴わせ、通知が飛ぶようにする（§6.4）

**人が全スレッドを手で resolve すれば承認が取れる**穴も残る。誰が resolve したかは問わないため、PR 作者が自分で全部 resolve すれば承認の条件を満たす。GitHub 自身が "Require conversation resolution before merging" で resolve をマージ条件として扱っているので解釈としては整合するが、自己承認の経路であることは変わらない。ここも README の記述に防御を置く。

`isOutdated` かつ未解決のスレッドは**未解決として数える**。outdated を解決済み扱いにすると、指摘箇所を書き換えるだけで指摘を消せてしまう。

## 10. テスト計画

純関数中心の既存方針を踏襲する。

**`tests/core/verdict.test.ts`（新規）**

- `REVIEW_MARKER` の無い Review を自分のものとみなさない
- 最新の `APPROVED` / `CHANGES_REQUESTED` を返す
- `DISMISSED` に当たったら `null` を返し、それより古い判定を掘り出さない
- `COMMENTED` / `PENDING` を読み飛ばす
- Review が 1 件も無いとき `null`

**`tests/core/resolution.test.ts`（新規）**

- 未解決スレッドに一致する key だけ `toResolve` に入る
- 既に解決済みの key は `ignored` に落ちる
- 存在しない key は `ignored` に落ちる
- 重複した key を畳む

**`tests/core/decision.test.ts`**

- `block-on` 以上の未解決があれば `REQUEST_CHANGES`
- 無ければ `APPROVE`
- `approve: false` なら `APPROVE` の代わりに `COMMENT`、新規コメントが無ければ `NONE`
- `block-on: none` なら `REQUEST_CHANGES` を出さない
- 破棄した指摘があるときは `APPROVE` を出さない
- 判定を提出できない PR で `REQUEST_CHANGES` / `APPROVE` が `COMMENT` に落ちる
- 生きている判定と同じなら、新規コメントがあれば `COMMENT`、無ければ `NONE`
- 今回 resolve に成功した分が未解決から差し引かれる

**`tests/core/schema.test.ts`**

- `resolved` を受け入れる / 省略時は空配列
- `key` が 12 桁 hex でなければ拒否する
- 空の `reason` を拒否する

**`tests/core/prompt.test.ts`**

- 未解決一覧の埋め込みと untrusted 宣言
- `auto-resolve: false` で未解決一覧を載せない
- `auto-resolve: false` でも解決済み一覧は載せる
- タイトルが `null` のスレッドを `file:line` と severity だけで出す

**`tests/core/marker.test.ts`**

- インラインコメント本文からのタイトル抽出
- タイトル書式が壊れているとき `null`
- 偽マーカーに対して末尾の正規ブロックが勝つ（既存テストの維持）

**`tests/core/render.test.ts`**

- resolve 返信の本文とサニタイズ
- Review 本文に「行を特定できなかった指摘」が出ない
- 破棄した指摘の件数とファイル名が出る

**`tests/orchestrate.test.ts`**

- resolve → 未解決が閾値未満 → `APPROVE` が 1 実行で完結する
- resolve に失敗したスレッドは未解決として数える
- 返信に失敗したスレッドを resolve しない
- 行が差分内に無い指摘をファイル単位コメントとして投稿する
- 差分外のファイルへの指摘を破棄し、`APPROVE` を出さない
- エージェント失敗時に自分の `APPROVED` を取り下げる
- 判定にも新規コメントにも変化が無いとき Review を作らない
- 差分ゼロのとき、エージェントを呼ばずにスレッドの現状から判定を出す

`src/io/github.ts` のテストは引き続き無い。危険な分岐（生きている判定の選択）は `core/verdict.ts` に切り出したので純関数側で覆える。残る `io/` の責務は API 呼び出しと GraphQL レスポンスの写像に限られる。

## 11. README への変更

- Inputs 表: `mode` と `request-changes-on` を削除し、`block-on` / `approve` / `auto-resolve` を追加
- Outputs 表: `resolved-count` を追加
- 冒頭の説明を「毎回フル差分をレビューする」「状態はレビュースレッドだけが持つ」に書き直す
- 「Incremental reviews」の節を削除し、代わりに `dedupe` による再投稿の防止を説明する節を置く
- 「`request-changes-on` and branch protection」を「`approve` is not a review」に書き換える。指摘を出すのも消すのも承認するのも同じモデルであること、ブランチ保護のゲートにしてはならないことを明記する
- 自動 resolve の節を追加する。判断の理由がスレッドへの返信として残ること、誤りは Unresolve で戻せること、bot は自動では戻さないこと
- 「Fail-closed behaviour」に、失敗時に自分の承認を取り下げることを追記する
- 「Not supported」から「Replying to review threads」を削除する（resolve の返信を投稿するようになるため）

## 12. 移行

破壊的変更を含むのでメジャーバージョンを上げて `v2` タグを切る。

| 変更                                 | 影響                                                  |
| ------------------------------------ | ----------------------------------------------------- |
| `mode` input の削除                  | 指定していた workflow は入力エラーになる              |
| `request-changes-on` → `block-on`    | 同上。既定値も `critical` → `major` に変わる          |
| `approve` / `auto-resolve` が既定 on | 明示的に無効化しない限り、bot が resolve と承認を行う |

v1 が投稿した Review には `SUMMARY_MARKER` が入っており、これは `REVIEW_MARKER` と同じ文字列なので、**v1 の PR でも自分の Review を識別できる**。互換シムは不要。

v1 の PR に残っている未解決スレッドは、v2 の初回実行で再検証の対象になる。既に直っているものはそこで resolve される。

## 13. 今回やらないこと

- **`pull_request_review_thread` トリガー。** 人が手でスレッドを resolve しても、判定が更新されるのは次の実行になる。bot が同一実行内で resolve するようになるため発生頻度が下がると見て、優先度を下げる
- **bot の誤 resolve の自動巻き戻し**（§6.3）
- **fork PR 対応**（`workflow_run` パターン）
- **`suggestion` ブロック**（ワンクリック適用）
- **指摘のカテゴリタグ**（security / correctness / perf / maintainability / test）
- **誤検知の明示的な抑制**（`review-bot-ignore` 等）
- **大きい PR の分割レビュー**（`diff-max-bytes` での切り捨ての代替）
- **PR 全体の未解決指摘を一覧できる場所。** フル差分に統一した代償として、どこにも出ない。必要になったら sticky コメントを最小構成で再検討する
