# coreの日本語訳で調整した箇所

| カードキー | 調整と理由 |
|---|---|
| `common.rules.korean_literals` | ハングルだけを対象としたエスケープ規則を、ASCII以外のユーザー向け文言をUTF-8のまま扱う規則にした。カードのファイル名は維持した。 |
| `claude_common.rules.language_tone` | 韓国語の俗語を避ける規則を、日本語の「ぶち込む」「突っ込んどく」などに置き換えた。長いダッシュと中黒は、文の構造を見えにくくする多用を避け、固有名詞などに必要な中黒は使う。 |
| `common.rules_scoped.codex.codex_bias_correction` | 判断を避ける表現の例を「断定はできません」「〜というわけではありません」など、日本語の文で見分けやすい形にした。 |
| `orchestrator.rules.general` | 判断の根拠を書く言語を日本語にした。 |

## 設定画面とインストール時の表記

- `common.soulstream_guide.first_window`と`common.soulstream_guide.settings`では、現在の設定ツールチップに合わせて`settings.title`の「設定」を使った。ログインを促す2文は`persistent.empty.signIn`と`persistent.empty.adminSignIn`の日本語値から`<br />`だけを除いた。
- `common.soulstream_guide.coding_login`の再接続の確認文は、原文が後半だけを引用しているため、辞書の`accounts.login.reconnectPrompt`の全文を使った。接続シートのタイトルとCLIのエラーには、該当するプロバイダー名を代入した。
- 「작업실」「일간 정리」はダッシュボード辞書の固定ラベルではなく、インストーラーが作る項目の名前である。日本語インストールでの名前「ワークスペース」「日次まとめ」を使った。各ガイドカードへの参照は、対応する日本語のカードタイトルに合わせた。
- `common.rules.workflow_md`の `[카드 실행]` と `[카드 커멘트]` はサーバーが出力する接頭辞なので保持した。
