# 简体中文目录翻译记录

## 本地化调整

| 卡片键 | 调整及原因 |
| :--- | :--- |
| `catalog.model_profiles.body` | 使用安装配置显示名 Seo Soyoung 和 Seo Soyoung (PAS)。保留模型预设 ID、后端系列和 `available: true` 条件。 |
| `catalog.ui_practice` | 将韩文输入的检索提示改为适用于中文、日文、韩文等语言的输入法输入。 |
| `catalog.ui_practice.body` | 分篇索引使用通用的输入法表述，适用于中文等语言。 |
| `catalog.ui_practice.shard.text_copy` | 拆分各语言的换行规则。简体中文用 `word-break: normal`，韩文用 `word-break: keep-all`，日文用默认换行并在支持时使用 `word-break: auto-phrase`。简体中文页面使用 `lang="zh-Hans"`，优先使用简体中文字体。英文标题大小写规则同样不适用于中文界面。 |
| `catalog.ui_practice.shard.interaction_platform` | 将确认最后一个韩文字的例子改为输入法确认候选词。保留 `event.isComposing`、`keyCode === 229` 和组字事件。 |
| `catalog.ui_practice.shard.controls_input` | 将忽略 Enter 的条件改为输入法正在组字，并用“简体中文”作短标签示例。 |
| `catalog.html_design_preset.body` | 保留韩文的 `keep-all` 和 `overflow-wrap: break-word`，另写简体中文和日文的换行条件，并说明简体中文的后备字体顺序。 |
| `catalog.html_design_preset.shard.index_preset` | 模板声明 `lang="zh-Hans"`，可见文字改为简体中文。字体优先使用 PingFang SC、Noto Sans SC、Microsoft YaHei，保留等宽字体的使用范围。 |
| `catalog.html_design_preset.shard.apple_preset` | 模板声明 `lang="zh-Hans"`，可见文字改为简体中文。将韩文字体栈改为简体中文字体优先的字体栈。 |
| `catalog.html_design_preset.shard.astryx_preset` | 根元素声明 `lang="zh-Hans"`，翻译示例文字和无障碍标签。保留元素结构、类名和主题属性。 |

## 界面文案

准确匹配的原文值按对应字典键取值。短标签、空状态和写作示例在字典中没有完全相同的原文值时，按原文含义翻译。

| 韩文原文 | 字典键 | 简体中文 |
| :--- | :--- | :--- |
| 저장 | `folders.common.save` | 保存 |
| 확인 | `cards.confirm` | 确认 |
| 저장 중… | `cards.saving` | 保存中… |
| 더 보기 | `cards.showMore` | 查看更多 |

| 韩文原文 | 无完全匹配时采用的译文 |
| :--- | :--- |
| 지우기 | 删除 |
| 올리기 | 上传 |
| 계속 | 继续 |
| 이름 바꾸기… | 重命名… |
| 여기에 입력하세요 | 请在此输入 |
| 총 N개 중 M개 | 共 N 项，已显示 M 项 |
| 로딩 중 | 加载中 |
| 새 글 없음 | 暂无新消息 |
| 제목 | 标题 |
| 한국어 | 简体中文（本地化短标签示例） |
| 알림 받기 | 接收通知 |
| 예 | 是 |
| 사진 1장 | 1 张照片 |

“分区”“列表”“保留”“主动省略”以及“对象 × 显示位置”是写作或审核示例。滚动条一项是 macOS 的设置说明，译文描述如何设置，不引用界面标签。HTML 模板的名称和表头是示例文本。
