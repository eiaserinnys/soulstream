# カタログの日本語翻訳ノート

## 日本語版に合わせた変更

| カードキー | 変更と理由 |
| :--- | :--- |
| `catalog.model_profiles.body` | モデルの識別子を保ち、既定プロフィールの表示名を「ソ・ソヨン」と「ソ・ソヨン(PAS)」に合わせた。 |
| `catalog.ui_practice` | 韓国語に限っていた検索の手がかりをIME入力に広げ、日本語や中国語の入力でも該当する指針を探せるようにした。 |
| `catalog.ui_practice.body` | 参照表の入力対象をIME入力に広げた。MWGの要約に使う言語を日本語と明記した。 |
| `catalog.ui_practice.shard.text_copy` | 日本語の`lang`と日本語フォントを先に指定する。韓国語は`keep-all`、日本語と中国語は標準の改行を使い、対応ブラウザーでは日本語に`auto-phrase`も使えるとした。文言の例を日本語に置き換え、Title Caseは日本語の画面文言に適用しないとした。 |
| `catalog.ui_practice.shard.interaction_platform` | 日本語、中国語、韓国語などのIME入力に適用する。Enterで末尾の一文字を確定する例を、変換候補を確定する例に広げた。 |
| `catalog.ui_practice.shard.controls_input` | IME変換中(`event.isComposing`)のEnterを送信や選択に使わず、ラベルの例を「日本語」に替えた。 |
| `catalog.ui_practice.shard.collections_media` | レビュー用の記録例を「残す」「意図して省く」にした。 |
| `catalog.html_design_preset.body` | 韓国語の`keep-all`と`overflow-wrap: break-word`を保った。日本語と中国語は標準の改行を使い、対応ブラウザーでは日本語に`auto-phrase`も使えるとした。 |
| `catalog.html_design_preset.shard.index_preset` | HTMLひな形を`lang="ja"`にし、見出しと本文の例を訳した。日本語フォントを優先する順序を示した。 |
| `catalog.html_design_preset.shard.apple_preset` | HTMLひな形を`lang="ja"`にし、見出しと本文の例を訳した。韓国語向けのフォント候補を日本語向けに差し替えた。 |
| `catalog.html_design_preset.shard.astryx_preset` | ルートを`lang="ja"`にし、ひな形の表示文言と`aria-label`の値を訳した。日本語フォントを優先する順序を示した。 |

三つのHTMLひな形で構造とテーマ属性を保った。CSSの寸法、色、トークン名も保った。カタログ登録用のキーと識別子、`{{node_id:…}}`の参照は原文どおりとし、説明と検索用の語句を日本語にした。

## ダッシュボード辞書に完全一致がない文言

| カードのシャード | 韓国語原文 | 日本語 |
| :--- | :--- | :--- |
| text-copy | 지우기 | 「削除」 |
| text-copy | 올리기 | 「アップロード」 |
| text-copy | 계속 | 「続ける」 |
| text-copy、controls-action | 이름 바꾸기… | 「名前を変更…」 |
| text-copy | 여기에 입력하세요 | 「ここに入力してください」 |
| scroll-overflow | 총 N개 중 M개 | 「全N件中M件」 |
| states-feedback | 로딩 중 | 「読み込み中」 |
| states-feedback | 새 글 없음 | 「新しい投稿はありません」 |
| controls-input | 제목 | 「タイトル」 |
| controls-input | 한국어 | 「日本語」 |
| controls-input | 알림 받기 | 「通知を受け取る」 |
| controls-action | 예 | 「はい」 |
| collections-media | 사진 1장 | 「写真1枚」 |

「섹션」「목록」は不要なメタラベルの例として「区分」「一覧」とした。「유지」「일부러 뺌」はレビューで使う記録の例である。「대상 × 보이는 자리」は確認表の軸を示すため、「対象×表示箇所」とした。「스크롤 막대 항상 보기」はmacOSの設定を指すので「スクロールバーを常に表示」とした。これらはダッシュボードの文言を引用する箇所とは区別した。
