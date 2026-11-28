# 简体中文核心卡片翻译说明

## 按语言调整的规则

| 卡片键 | 调整及原因 |
| :--- | :--- |
| `common.rules.korean_literals` | 将只针对韩文的转义规则扩展到非 ASCII 用户文案。保留 UTF-8、序列化时保留原字符，以及外部系统强制 ASCII 转义时先征求同意的要求。 |
| `claude_common.rules.language_tone` | 用“怼进去”“焊死”等中文网络用语说明同一写作问题。按中文习惯使用顿号、逗号和句号，专名需要的间隔号保留。 |
| `common.rules_scoped.codex.codex_bias_correction` | 用“我不认为”“我不敢说”等中文例句说明含糊表态的问题。改写后的例句直接报告观察结果，在影响任务时写明未验证的范围。 |
| `orchestrator.rules.general` | 调度判断依据改用简短、具体的中文。JSON 输出契约保持原样。 |
| `common.rules_templates.delegation_prompt` | 将模板内的说明和供人填写的提示译成中文，保留段落结构及 `{cardId}`、`{folderId}`、`{branchName}` 等命名字段。 |
| `common.soulstream_guide.install` | SSH 示例及说明使用 `<用户>` 和 `<服务器>`，其余命令原样保留。安装名称使用“工作区”、Seo Soyoung、Seo Soyoung (PAS) 和“卡片编排器”。 |
| `coding_common.rules_extra.spec_quality_gate` | 搜索示例使用“文件路径”和 `{文件}`，命令与标识符保持原样。原文已删除空的第 10 小节，译文按更新后的原文编排。 |

## 界面文案

- `common.soulstream_guide.first_window` 和 `common.soulstream_guide.settings` 的按钮提示与窗口标题采用 `settings.title` 的“设置”。
- `common.soulstream_guide.first_window` 的两条登录提示采用 `persistent.empty.signIn` 和 `persistent.empty.adminSignIn`，只移除 `<br />`。
- `common.soulstream_guide.settings` 按字典保留四个分组和 20 个选项卡的名称，采用原文顺序。管理员标记写作“（管理员）”，选项卡前缀所用的半角冒号是种子格式约定。任务名称采用“每日整理”。
- `common.soulstream_guide.coding_login` 的“Codex 연결”“Antigravity 연결”来自 `accounts.login.connectTitle`，代入供应商名称。“지금 로그인은 새 로그인으로 바뀝니다”采用 `accounts.login.reconnectPrompt` 的完整提示。“이 노드에 Codex CLI가 없습니다”“Antigravity CLI가 없습니다”来自 `accounts.login.cliMissing`，代入相应 CLI 名称。
- 未收录在界面字典中的名称是安装名称或卡片标题。“작업실”和“일간 정리”按安装约定采用“工作区”和“每日整理”。“코딩 에이전트 로그인”“다시 설치와 업데이트”“설치되는 것과 여는 법”“다시 설치할 때 되돌아가는 설정”分别引用译后的卡片标题“登录编程智能体”“重新安装与更新”“安装内容与访问方式”“重新安装时恢复的设置”。

## 保留的文字

- `common.rules.workflow_md` 保留服务器产生的 `[카드 실행]` 和 `[카드 커멘트]`。代码依据为 `orch-server-ts/src/cards/card_prompt.ts:26` 和 `orch-server-ts/src/cards/card_change_notification.ts:73`。
- 本组原文没有具体模型预设 ID、请求问题的服务器答复值“했어”、`[별건]` 前缀或技能链接块。涉及另案的普通文字使用“另案”。选取预设的说明保留“可用”这一条件。
