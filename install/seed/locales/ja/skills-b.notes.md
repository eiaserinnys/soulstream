# 日本語版skills-bの翻訳記録

## 日本語版に合わせた変更

| カードキー | 変更と理由 |
| :--- | :--- |
| `skill.atom_search.body` | 日本語の知識ベースを想定し、バッチ処理を探す自然文とOR検索の例を日本語にした。技術用語と検索手順は維持した。 |
| `skill.agent_delegation.body` | ソ・ソヨンの韓国語の語尾指定を、日本語の指示文の常体と「〜でございます」「〜いたします」などの丁寧な語り口に置き換えた。 |
| `skill.modern_web_guidance.body` | ハングル入力に限らず、IME変換中のEnterを`event.isComposing`で除外するようにした。Enterで改行、Shift+Enterで送信する操作は維持した。 |
| `skill.html_make.body` | HTMLの例を`lang="ja"`にし、日本語のシステムフォントを優先した。日本語に`word-break: normal`と対応ブラウザー向けの`auto-phrase`を案内し、`keep-all`は韓国語の文に限定した。 |
| `skill.daily_review`、`skill.daily_review.body` | インストール時に付ける名前「日次まとめ」「ワークスペース」にそろえた。点検件数の報告と選択肢はエージェントが書く文言なので、日本語にした。 |
| `skill.soulstream_session.body` | 既定プロフィールを「ソ・ソヨン(PAS)」「ソ・ソヨン」と表記した。メインPASの例も「ソ・ソヨン常駐セッション」にした。実際の送信には一覧から取得したIDを使う。 |
| `skill.lite_delegation.body`、`skill.node_model_selection.body` | 軽量委任の例と作業別の表には原文のプリセットIDを残した。実際に使えるプリセットはノードのカタログで確認する。 |

## 画面表示と実行時の文字列

- `skill.soulstream_guide.body`の「atomを開く」は`sessions.openAtom`。設定の操作例は`settings.title`、`settings.tabs.coding_agents.label`、`accounts.common.connect`、`settings.tabs.agents.label`、`settings.tabs.persistent_defaults.label`にそろえた。
- `skill.git_setup.body`の「エージェントとノード」「Gitとリポジトリ」は`settings.groups.agents`と`settings.tabs.git_repos.label`。依頼への回答値「했어」はサーバーが生成する値なので維持し、画面表示「対応しました」(`cards.doneResponse`)を併記した。
- `skill.html_make.body`の「記録と管理」「ファイルストレージ」は`settings.groups.records`と`settings.tabs.file_storage.label`。
- `skill.daily_review.body`の「모두 진행」「일부만」「오늘은 건너뜀」「새로 닫힌 카드 N장으로 건너뜀」は画面辞書にない。エージェントが入力する選択肢と確認項目なので、「すべて進める」「一部だけ進める」「今日は見送る」「新たに閉じたカードはN枚のためスキップ」とした。
- `skill.skill_link_blocks.body`はコンパイラーの出力例と、出力を指す引用に韓国語を残した。「작업에 맞는 것을 골라 읽는다」も`skill_compile.ts`が出力する。

## ひな形と参照

- `skill.retrospective.body`、`skill.work_plan.body`、`skill.general_create_rule.body`のひな形は、見出し、文言、人が埋める欄を日本語にした。出力の構造と識別子は維持した。リポジトリ内で日本語に合わせて変更が必要な、これらの見出しを読むコードは見つからなかった。
- `skill.atom_zettelkasten.body`の無効化表示「[無効化済み YYYY-MM-DD]」はカード本文の慣例で、コードが読む値ではない。
- `skill.skill_link_blocks.body`の`section: "担当と所属"`は、展開されない説明用フェンスの例である。原文の「담당과 소속」は`card-work`の実在見出しではない。実際にincludeするときは対象の見出しをそのまま使うよう追記した。
- `skill.work_plan.body`、`skill.work_plan_execute.body`、`skill.recurring_jobs.body`、`skill.daily_review.body`から`card-work`の各節を指す箇所は、エージェントが読む案内である。日本語版のskills-aを合わせる際に節名の表記を照合する。
- 「日次まとめ」はガイドの設定カードとPASの役割カードでも同じ名前にする。「ソ・ソヨン常駐セッション」と「常駐セッション(PAS)を探す」は、`card-work`から参照する箇所でも照合する。
