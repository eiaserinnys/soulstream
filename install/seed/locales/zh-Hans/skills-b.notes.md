# 简体中文 skills-b 翻译备注

## 本地化调整

| 卡片键 | 调整及原因 |
| :--- | :--- |
| `skill.atom_search.body` | 查询示例改用中文。保留“一次处理多项任务”的批处理意图、OR 同义词扩展及按子树筛选的步骤。 |
| `skill.agent_delegation.body` | 将韩语语体和示例改为古雅、恭敬的中文，保留 Seo Soyoung 的人格要求。 |
| `skill.soulstream_session.body` | 使用安装约定的配置名 “Seo Soyoung (PAS)”和“Seo Soyoung”。新建主 PAS 的会话名为“Seo Soyoung”，默认创建路径使用 `bootstrapDisplayName` 剥去配置名的 ` (PAS)` 后缀。见 `orch-server-ts/src/session/persistent_session_settings_service.ts:396` 和 `orch-server-ts/src/session/persistent_session_bootstrap.ts:46`。 |
| `skill.modern_web_guidance.body` | Enter 处理适用于所有输入法。用 `event.isComposing` 识别组字，保留 Enter 换行、Shift+Enter 发送的规则。 |
| `skill.daily_review`、`skill.daily_review.body` | 重复任务和默认文件夹按安装命名约定写为“每日整理”和“工作区”。当前基准中，条目与正文合计有 7 处“일간 정리”。 |
| `skill.html_make.body` | HTML 样例使用 `lang="zh-Hans"`，在系统字体栈中优先使用简体中文字体。中文使用 `word-break: normal`，韩文保留 `word-break: keep-all; overflow-wrap: break-word`。 |

## 界面文案与运行时文本

- “设置”“当前情况”“打开 atom”“连接编程智能体”“连接”“智能体配置”“常驻会话默认模型”“智能体与节点”“Git 与仓库”“记录与管理”“文件存储”“我已处理”均用同名界面项目的简体中文词条。设置使用 `settings.json`，当前情况和请求答复使用 `cards.json`，打开 atom 使用 `sessions.json`，账号连接操作使用 `accounts.json`。
- `skill.atom_zettelkasten.body` 的“Atom 탐색”（仪表盘实验室中的功能）无对应词条，译为“Atom 探索”。`skill.modern_web_guidance.body` 的 Baseline “널리 사용 가능”是外部术语，译为“广泛可用”，无需在 Soulstream 词典中查找。
- `skill.daily_review.body` 的 “모두 진행”“일부만”“오늘은 건너뜀”和“새로 닫힌 카드 N장으로 건너뜀”是智能体填写的选项与检查项文案，没有同用途的固定词条。分别译为“全部处理”“只处理部分”“今天跳过”和“新关闭 N 张卡片，本次跳过”。
- `skill.git_setup.body` 保留服务器用于请求型问题回答的 `했어`，并注明按钮显示为“我已处理”（`cards.doneResponse`）。依据 `orch-server-ts/src/cards/card_control_plane_service.ts:550`、`unified-dashboard/client/v3/CardQuestionBlock.tsx:185`。
- `skill.skill_link_blocks.body` 保留编译器实际输出的 `링크: call`、`링크: include`、`링크: pick`、`링크 오류`、`위에서 펼침`、`그때 load_skill로 부른다`、`작업에 맞는 것을 골라 읽는다`。对应源码位置见 `hangul-allowlist.json`。

## 模板、链接和引用

- `skill.retrospective.body`、`skill.work_plan.body`、`skill.general_create_rule.body` 的模板标题、标签与供人填写的占位名已译，结构和机器标识保留。在仓库代码及其他 seed 卡片中未找到对这些模板标题的逐字匹配。
- `skill.skill_link_blocks.body` 的 `section: "담당과 소속"` 在外层代码围栏中，是说明用示例，译为 `section: "负责人和所属会话"`。原韩文是 `common.rules.workflow_md` 的标题，本例的 `card-work` 目标中没有同名小节。实际展开的 `include` 仍须逐字匹配目标标题（`orch-server-ts/src/skills/link_blocks.ts:216`）。
- 面向读者的 `card-work` 小节引用使用 skills-a 中 `skill.card_work.body` 的实际标题。`skill.work_plan.body` 引用“卡片问答与发言者”“创建卡片”“显式开工”“负责会话的规则”。`skill.work_plan_execute.body` 引用“将范围外发现发给 PAS”“一句结果和证据要能直接查看”“没有检查项的旧卡片”“卡片问答与发言者”。`skill.recurring_jobs.body` 引用“状态”。`skill.daily_review.body` 引用“创建卡片”“由负责会话完成定期任务卡片”。
- `skill.card_work.body` 引用本组 `skill.soulstream_session.body` 的“查找常驻会话 (PAS)”。两处均使用配置名 Seo Soyoung (PAS) 定位主 PAS。
- `skill.node_model_selection.body`、`skill.lite_delegation.body` 的模型预设 ID 和可用性条件按原文保留。
