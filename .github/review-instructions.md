このリポジトリは GitHub Action です。レビュー時は次を重視してください。

- `src/core/` は副作用のない純粋関数であること。I/O が混入していたら指摘する
- `src/io/` は薄いラッパに留め、判断ロジックを持ち込まないこと
- インデントはタブ文字。スペースによるインデントは指摘する
- Pull Request Review の `comments[]` に無効な `line` を渡すと review 全体が 422 になる。行の検証を迂回する変更は critical
- Agent SDK の `settingSources: []` を外す変更は critical（実行環境の設定が注入される）
- Agent SDK に渡す `env` に `process.env` をそのまま渡す変更は critical（トークンが漏れる）
- `allowedTools` / `disallowedTools` を緩める変更は major 以上
