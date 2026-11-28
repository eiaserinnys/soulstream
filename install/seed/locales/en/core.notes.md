# Core English translation notes

## Adaptations for English

| Card key | Reason |
| :--- | :--- |
| `common.rules.korean_literals` | Generalizes the Korean-only escape rule to non-ASCII user text. The rule still requires UTF-8, preserves Unicode when serializing, and requires confirmation if an external system forces ASCII escapes. |
| `claude_common.rules.language_tone` | Replaces Korean community slang with English examples such as “shove it into the prompt” and “slam it into the code.” The punctuation rule applies to joining clauses or separating items in English prose and preserves literal syntax. |
| `common.rules_scoped.codex.codex_bias_correction` | Uses English hedges such as “I won't assume” to show the same pattern. The revised examples report observations and state verification gaps only if they affect the task. |
| `orchestrator.rules.general` | Gives scheduling reasons in English and retains the JSON output contract. |
| `common.rules_templates.delegation_prompt` | Translates the text within the fenced templates, including human-readable slot instructions, while keeping the template structure and named slots such as `{cardId}`, `{folderId}`, and `{branchName}`. |

## Source wording without an exact dashboard dictionary match

| Korean source | English guide wording | Evidence |
| :--- | :--- | :--- |
| 서버 설정 | Settings | The toolbar uses `settings.title` for its title and accessible label. The quoted Korean wording is absent from the dictionaries. |
| 코딩 에이전트를 연결하면 기본 영구 세션을 만듭니다 | The dashboard asks you to sign in to a coding agent to create the default persistent session. | The current empty state uses `persistent.empty.signIn` and `persistent.empty.adminSignIn` for two roles. The source phrase summarizes both. |

## Literal and display choices

- `[카드 실행]` and `[카드 커멘트]` are emitted by the server and stay in Korean. The core cards contain no `[별건]` prefix or request completion answer `했어`. References to separate work in prose use ordinary English.
- The SSH command keeps its source placeholders `<사용자>` and `<서버>`. The guide explains in English which value replaces each one. The spec verification example likewise keeps `{파일}` as a shell example placeholder and translates the comments.
- The guide uses the installed names "Workspace," "Daily review," Seo Soyoung, Seo Soyoung (PAS), and Card orchestrator.
- The English pass follows `sentence-english-docs`. It uses sentence case headings, puts conditions before instructions, and separates clauses without dash punctuation. The settings list follows the dictionary verbatim, including the group headings, tab labels, and admin marks.
