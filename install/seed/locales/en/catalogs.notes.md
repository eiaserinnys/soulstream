# English catalog translation notes

## Language adaptations

| Card key | Adaptation |
| :--- | :--- |
| `catalog.ui_practice` | Use IME input as a discovery cue so the interaction guidance also covers Japanese and Chinese. |
| `catalog.ui_practice.body` | Use IME input, including Korean, Japanese, and Chinese, in the shard selection table. |
| `catalog.ui_practice.shard.text_copy` | Match `lang` and font fallbacks to content. Keep the CJK wrapping rule and describe normal English wrapping and hyphenation separately. Use English UI copy examples and sentence case as the default for English labels. |
| `catalog.ui_practice.shard.interaction_platform` | Apply the composition guard to IMEs generally, including Korean, Japanese, and Chinese. Describe Enter committing a character or candidate. |
| `catalog.ui_practice.shard.controls_input` | Apply the Enter guard during IME composition and use "English" as the example locale label. |
| `catalog.html_design_preset.body` | Retain the CJK CSS and describe normal wrapping and optional hyphenation for English. |
| `catalog.html_design_preset.shard.index_preset` | Set the English sample to `lang="en"`. Use system fonts for English and keep Pretendard Variable as the first choice for Korean where available. |
| `catalog.html_design_preset.shard.apple_preset` | Set the English sample to `lang="en"`. Keep the Korean font stack and use system fonts for English. |
| `catalog.html_design_preset.shard.astryx_preset` | Translate the sample text and accessible name and set the root language to `lang="en"`. Preserve the theme attributes and use the shared system font stack. |

## UI wording without an exact dictionary match

| Card shard | Korean source | English example |
| :--- | :--- | :--- |
| text-copy | 지우기 | "Delete" |
| text-copy | 올리기 | "Upload" |
| text-copy | 계속 | "Continue" |
| text-copy, controls-action | 이름 바꾸기… | "Rename…" |
| text-copy | 여기에 입력하세요 | "Enter text here" |
| scroll-overflow | 총 N개 중 M개 | "Showing M of N" |
| states-feedback | 로딩 중 | "Loading" |
| states-feedback | 새 글 없음 | "No new posts" |
| controls-input | 제목 | "Title" |
| controls-input | 한국어 | "English" |
| controls-input | 알림 받기 | "Receive notifications" |
| controls-action | 예 | "Yes" |
| collections-media | 사진 1장 | "1 photo" |

"Section" and "List" are examples of redundant labels. "Keep" and "Remove intentionally" are review annotations. The scroll bar setting belongs to macOS. These examples use English wording appropriate to their context.
