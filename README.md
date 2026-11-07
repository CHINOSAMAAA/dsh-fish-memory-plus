# 鱼的记忆 · Plus

> **来源与许可**
>
> 本项目派生自 [Yuuyuko-uu/dsh-fish-memory](https://github.com/Yuuyuko-uu/dsh-fish-memory)，原作者 **[Yuuyuko-uu](https://github.com/Yuuyuko-uu)**。
>
> 继续采用原作者声明的 **[Yuuyuko-uu 插件许可 1.2](https://github.com/Yuuyuko-uu/dsh-fish-memory/blob/main/LICENSE)**，完整许可保留在本仓库 [LICENSE](LICENSE)。

由 **CHINOSAMAAA** 维护的衍生版本，重点扩展 QQ 记忆隔离、旧数据迁移和可选的 Qwen 语义召回。

[本项目改动](#本项目改动) · [安装与使用](#安装与使用) · [语义召回](#语义召回) · [原版文档与开发](#原版文档与开发)

## 本项目改动

| 方向 | 相对原仓库的修改 |
| :--- | :--- |
| **QQ 来源分库** | 按机器人账号、私聊对象和群聊范围确定记忆库；隔离群独立存储，普通群使用同机器人下的共享库。 |
| **受限跨库召回** | 仅配置主人的可信私聊轮次可查询自己的私聊、当前已绑定隔离群及普通群共享库，不包含其他人的私聊；其他入口遵循各自可读范围。 |
| **可信来源校验** | 对接 [QQ Plus](https://github.com/CHINOSAMAAA/dsh-qq-link-plus) 的账号核验、独占聊天映射和宿主消息凭据，正文、昵称或来源标题不能赋予主人权限。 |
| **管理操作固定原库** | 编辑、删除、导入等请求携带预览时的库 ID；配置或绑定变化后拒绝过期任务，跨库查询结果不会保存成一个合并库。 |
| **旧数据迁移** | 新增迁移预览、原件备份及可信条目导入；来源不明的条目列为待处理，迁移保留原件，重复执行不重复导入。 |
| **Qwen 语义召回** | 增加默认关闭的 DashScope Embedding 接入；关键词与语义各自筛选相关候选，取并集后沿用原有遗忘、重要度、情绪和时间排序。 |
| **独立向量索引** | 正文仍以原记忆 JSON 为准；向量单独缓存，支持分批补齐、中断、续跑和重建，失效或故障时回退关键词召回。 |
| **配置与诊断** | 增加主人 QQ、隔离群、语义模型、只写密钥及索引状态配置，展示语义相似度、向量缺失和回退原因。 |
| **回归与评估** | 补充来源隔离、迁移、模拟 DashScope、过期任务及小样本混合召回评估。 |

**代码基线：**原作者 `dsh-fish-memory 1.5.2`，对应提交 [5124cc1](https://github.com/Yuuyuko-uu/dsh-fish-memory/commit/5124cc1fa5a3149e8a68cf1d858e24b5bf2a2eea)。本仓库版本以 [package.json](package.json) 为准；修改历史见 [CHANGELOG.md](CHANGELOG.md)。

## 安装与使用

在 DSH 插件管理器中安装本仓库：

```text
github:CHINOSAMAAA/dsh-fish-memory-plus
```

Web profile 也可使用命令行：

```bash
dsh plugin --profile web add github:CHINOSAMAAA/dsh-fish-memory-plus
```

桌面版通过应用内插件管理器操作，安装后按宿主提示重载或重启。QQ 相关扩展需搭配 [dsh-qq-link-plus](https://github.com/CHINOSAMAAA/dsh-qq-link-plus)。

> Plus 当前保留原包名 `dsh-fish-memory` 和 `/dsh-fish-memory/*` 接口，请按上述 GitHub 地址安装。同一环境不要同时启用原版、Plus 或已内置本模块的 [大肥鱼整合包](https://github.com/CHINOSAMAAA/dsh-big-fish-aio)。

### QQ 记忆隔离

先在 QQ Plus 中为每个聊天绑定独立的 DSH 会话，再到鱼的记忆设置填写「主人 QQ」和「隔离群号」。每个绑定聊天先经实时轮询接收一条消息，以建立可核验的来源。

| 消息入口 | 写入与召回范围 |
| :--- | :--- |
| **主人可信私聊** | 写入自己的私聊库；可只读召回自己的私聊、同机器人当前已绑定隔离群及普通群共享库。 |
| **隔离群** | 读写本群独立库。 |
| **其他已绑定群** | 读写同机器人下的普通群共享库。 |
| **其他人的私聊** | 读写该对象自己的私聊库，继续遵守会话开关。 |
| **非 QQ 会话** | 继续使用原有会话 / 工作区模式。 |

来源未知、账号核验失败或绑定存在歧义时，不授予跨库权限；尚未核验的 QQ 入口暂停记忆读写。QQ 库不参加工作区合并、跨库复制或分支继承。修改隔离配置只影响后续库路由，不搬动旧库，也无法撤回已进入对话历史的内容。

### 迁移已有数据

1. 点击「预览旧数据迁移」，核对候选条目，以及混用、缺来源或损坏的待处理项。
2. 点击「备份并迁移可信条目」，先备份原件到 `$DSH_HOME/fish-memory-qq-migration-backup/`；备份失败则不开始导入。
3. 对待处理条目人工确认归属后，使用管理界面逐库添加或导入。

迁移保留原文件，重复执行不会重复导入；不能仅根据当前绑定或来源标题认定历史归属。管理脚本操作 QQ 记忆时，需要提供预览时的 `storeId`。

## 语义召回

**默认关闭。启用后，记忆正文和查询会发送给配置的服务商，并可能产生费用。**

1. 打开「Qwen 语义召回」，填写 DashScope 原生 Embedding 完整地址、模型和维度。支持 `text-embedding-v3` / `text-embedding-v4`，当前不接受 OpenAI 兼容 `/embeddings` 地址。
2. 使用只写密钥框配置凭据，优先读取宿主凭据 `FISH_MEMORY_QWEN_API_KEY`，其次为 `DASHSCOPE_API_KEY`；旧宿主使用同名环境变量。界面不返回密钥，也不把它写进普通配置文件。
3. 保存并启用，在目标库点击「补齐当前库索引」。每批最多 10 条，可中断后继续；重建索引保留记忆正文。
4. 根据自己的问题与记忆校准门槛。当前默认维度为 1024、语义门槛为 0.75、候选上限为 12 条，本轮查询超时为 1800ms。

| 行为 | 说明 |
| :--- | :--- |
| **排序与遗忘** | 语义命中只参与相关候选筛选，不触发记忆强化；最终仍使用原有遗忘排序和条数、字符预算。 |
| **权限范围** | 两路召回共用现有 QQ 可读库集合；跨库查询不会写入群库或为群库后台生成向量。 |
| **降级方式** | 未启用、缺少密钥或向量、超时、429、服务异常及宿主阶段能力不足时，保留关键词召回。 |
| **正文边界** | 单条输入上限为 8192 UTF-8 字节；超长正文不截断，继续保留关键词召回。 |
| **缓存位置** | `$DSH_HOME/fish-memory-vectors/`，按库与服务配置区分；修改、删除或清库后丢弃过期向量。 |

## 原版文档与开发

原作者的长期记忆原理、日常使用、遗忘参数、档案导入与常见问题，请直接阅读 **[源仓库 README](https://github.com/Yuuyuko-uu/dsh-fish-memory#readme)**。本页仅维护 Plus 的改动与使用差异。

| 入口 | 地址 |
| :--- | :--- |
| 原作者项目与发布记录 | [源仓库](https://github.com/Yuuyuko-uu/dsh-fish-memory) · [Releases](https://github.com/Yuuyuko-uu/dsh-fish-memory/releases) |
| Plus 问题反馈 | [本仓库 Issues](https://github.com/CHINOSAMAAA/dsh-fish-memory-plus/issues) |
| QQ 扩展说明 | [dsh-qq-link-plus](https://github.com/CHINOSAMAAA/dsh-qq-link-plus#readme) |
| 版本与提交规则 | [AGENTS.md](AGENTS.md) |

本地验证：

```bash
npm test
npm run evaluate:hybrid
```

测试和评估使用合成数据及模拟服务，不调用付费 API。固定小样本只能验证协议、排序与权限管线，不能证明真实 Qwen 的语义质量或默认门槛最优；真实 QQ、Qwen 账号与桌面宿主仍需分别验收。

### 第三方来源

- Embedding 实现参考 [Aonysen/dsh-memory-rag](https://github.com/Aonysen/dsh-memory-rag/tree/9527a91f49863e7f16e109335e44b137e436dc41)，**Copyright 2026 aonysen**，Apache-2.0。参考项目的 [许可](lib/notices/dsh-memory-rag-LICENSE) 与 [NOTICE](lib/notices/dsh-memory-rag-NOTICE) 保留在仓库中；未移植其向量数据库与权限体系。
- 中文词典和词频来自 [fxsjy/jieba](https://github.com/fxsjy/jieba)，处理方式及许可说明见 [词典来源](lib/词典-来源.txt)。
- DashScope 接口格式参见 [百炼官方 Embedding 文档](https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api)。
