# dsh-workspace-profile 0.6.0 开发升级计划

> 本文档是 0.6.0 的需求与验收基准，由用户于 2026-10-01 给出，原样收录。
> 实施结论记录在 `MILESTONE-0.6.md`；本文件不随实施过程改写。

## 一、版本目标

0.6.0 不重构现有 Workspace Profile 的核心架构，而是在 0.5.0 已有的：

`Workspace → Profile / Perspective → Subagent Registry → SubagentDispatcher`

基础上增加两个能力：

**第一，Subagent 支持不同执行 Backend。**

除现有 DSH `spawn` 子代理外，允许指定 Workspace Subagent 使用官方 Codex Backend。

**第二，对话框增加 `@子代理` 直接调用。**

用户可以直接输入：

```text
@码农 修一下这里的类型错误
@代码专家 修复 KDocs Sidebar 白屏并运行测试
@代码架构师 审查一下当前插件架构
@律师助理 整理这批案件材料
```

直接调用指定子代理，而不需要先经过主 Agent 判断。

现有：

```text
workspace_subagent
/agent
```

全部保留。

最终形成：

```text
                 Workspace Subagent Registry
                           │
                    SubagentDispatcher
                           │
          ┌────────────────┴───────────────┐
          │                                │
        spawn                            codex
          │                                │
 DS / Kimi / GPT 等 DSH Agent          原生 Codex
```

调用入口则变成：

```text
模型自动调用 workspace_subagent ──┐
                                 │
用户输入 /agent xxx ─────────────┼──→ SubagentDispatcher
                                 │
用户输入 @子代理 ────────────────┘
```

原则继续保持：

> One Dispatcher, multiple entry points.

---

# 二、工程角色设计

0.6.0 不删除任何现有角色。

工程类默认提供三个角色。

## 1. 码农 `coding`

**保留 0.5.0 原有模板与行为。**

```text
名称：码农
Key：coding
Backend：spawn
Provider：deepseek-official
Model：deepseek-flash
Reasoning：保持当前配置
```

主要承担：

- 普通代码阅读；
- 小规模 Bug 修复；
- 简单脚本；
- 配置文件修改；
- 小功能实现；
- 日常插件维护；
- 批量、机械性工程工作。

定位：

> 低成本、高频率工程执行者。

不因为 Codex 加入而弃用，也不自动转换已有 `coding` 定义。

已有 Workspace 中的"码农"配置原样保留。

---

## 2. 代码专家 `code-expert`

新增模板。

```text
名称：代码专家
Key：code-expert
Backend：codex
Model：跟随 Codex 原生配置
```

主要承担：

- 仓库级代码修改；
- 多文件实现；
- 复杂 Bug 定位与修复；
- DSH 插件开发；
- CLI / MCP / Skill 开发；
- 测试编写与执行；
- 重构；
- 构建错误处理；
- 依赖和接口实现；
- 需要真正进入仓库完成工作的工程任务。

角色定义建议：

```text
你是代码专家，负责在真实代码仓库中完成工程任务。

开始工作前先阅读相关源码、配置和项目约束，不根据猜测修改代码。

优先复用项目已有架构、工具和基础设施，不因未来可能有用而新增复杂抽象。

修改代码后，应尽可能执行相关测试、构建或检查，并明确说明：

1. 实际检查了什么；
2. 实际修改了什么；
3. 执行了哪些验证；
4. 哪些事项尚未验证；
5. 是否存在需要人工决定的问题。
```

Codex 不在 Workspace Profile 中固定模型。

```text
backend: codex
```

意味着：

> 使用 DSH 官方 Codex Provider，并遵循 Codex 自身原生模型配置。

Workspace Profile 不接管 `~/.codex/config.toml`。

---

## 3. 代码架构师 `code-architect`

新增模板。

```text
名称：代码架构师
Key：code-architect
Backend：spawn
Model：GPT-6.1 Sol
Reasoning：high
```

主要承担：

- 系统架构设计；
- 模块边界判断；
- 复杂技术方案比较；
- 根因分析；
- 跨模块问题；
- 大规模重构前设计；
- Codex 实现结果审查；
- 技术债和兼容性分析；
- 难以定位的问题第二意见。

原则上：

> 代码架构师以分析、设计和审查为主，而不是承担大量机械性代码修改。

GPT-6.1 Sol 的真实 `provider/model` ID 不在源码中猜测或硬编码。

模板应用时从：

```text
models()
```

返回的 DSH 实际模型目录中解析。

仅在唯一匹配到 GPT-6.1 Sol 且支持 `high` 时自动填入。

如果没有唯一匹配：

```text
不猜
不 fallback 到其他 GPT
不偷偷改模型
```

而是在 UI 中提示用户从实际模型目录选择。

---

# 三、三个工程角色的边界

| 角色 | 主要定位 | 成本倾向 | 是否实际改代码 |
|---|---|---:|---|
| 码农 | 日常、简单、高频工程任务 | 低 | 是 |
| 代码专家 | 复杂仓库实施、调试、测试 | 中 | 是，核心职责 |
| 代码架构师 | 架构、复杂分析、审查 | 高 | 可以，但不是主要职责 |

典型路由：

```text
简单 CSS / 配置 / 小 Bug
→ 码农

跨多个文件实现一个完整功能
→ 代码专家

DSH 插件真实仓库修复
→ 代码专家

设计 Workspace Profile 下一代架构
→ 代码架构师

Codex 改完以后觉得不放心
→ 代码架构师复核

复杂问题暂时不知道应该怎么改
→ 先代码架构师
→ 再代码专家实施
```

但不建立硬编码关键词路由。

K3 根据角色 Description 自己选择。

---

# 四、Subagent 数据模型升级

现有定义大致为：

```js
{
  id,
  key,
  name,
  description,
  provider,
  model,
  reasoningEffort,
  enabled
}
```

0.6.0 增加：

```js
backend
```

形成：

```js
{
  id,
  key,
  name,
  description,

  backend,

  provider,
  model,
  reasoningEffort,

  enabled
}
```

Backend 第一版只允许：

```text
spawn
codex
```

暂时不要抽象为：

```text
executor
runtime
adapter
engine
backendConfig
```

避免过度设计。

---

# 五、兼容策略

这是本次升级的重要红线。

所有 0.5.0 及以前保存的 Subagent：

```js
backend === undefined
```

统一解释为：

```js
backend = 'spawn'
```

因此原来的：

```text
码农
律师助理
独立评审员
自定义 Subagent
```

全部行为不变。

不执行数据迁移。

不批量改配置。

不改变用户现有 Workspace。

只有用户新建或者主动编辑 Subagent 时，才保存明确的 `backend`。

---

# 六、Subagent Registry 修改

重点修改：

```text
src/subagent-registry.js
```

增加：

```text
backend: 'spawn' | 'codex'
```

校验规则根据 backend 分开。

### spawn

必须存在：

```text
provider
model
```

`reasoningEffort` 可选。

### codex

不要求：

```text
provider
model
reasoningEffort
```

因为这些不是 DSH LLM route。

Codex 模型由 Codex Provider 自己决定。

---

# 七、Dispatcher 重构

当前核心问题是：

```js
SUBAGENT_PROVIDER = 'spawn'
```

以及：

```js
ctx.subagents.start('spawn', ...)
```

被固定。

0.6.0 改成：

```text
definition
   │
   └── backend
          │
          ├── spawn
          └── codex
```

但不要简单写：

```js
subagents.start(definition.backend, samePayload)
```

因为两种 Backend 能力不同。

---

# 八、Spawn 执行路径

保持现有行为。

类似：

```js
subagents.start('spawn', {
  parent: agent,
  label,
  prompt,
  signal,

  agentOptions: {
    provider,
    model,
    reasoningEffort
  },

  persona,
  maxDepth
})
```

继续支持：

- DeepSeek；
- Kimi；
- GPT；
- 其他 DSH Model Provider。

因此：

```text
码农
律师助理
独立评审员
代码架构师
```

都继续走这一套。

---

# 九、Codex 执行路径

代码专家：

```text
backend = codex
```

Dispatcher 改走：

```js
subagents.start('codex', {
  parent: agent,
  label,
  prompt,
  signal
})
```

不得附带：

```text
agentOptions
persona
toolFilter
outputSchema
maxDepth
```

因为官方 Codex Provider 当前属于 out-of-process backend，不支持这些 DSH child start capabilities。

因此 Dispatcher 必须明确存在：

```text
buildSpawnRequest()
buildCodexRequest()
```

而不是一个巨大的通用 Request。

---

# 十、Prompt 编译重构

当前 `compileDispatchTask()` 不应该继续承担所有角色。

0.6.0 拆成三层：

```text
compileBaseTask()
compileSpawnTask()
compileCodexTask()
```

## Base

只包含：

```text
Workspace
Matter（存在时）
任务
基本边界
```

## Spawn

额外使用：

```text
persona
provider/model
DSH Agent 能力
```

## Codex

由于不支持 persona，把角色身份直接编译到 task 文本。

例如：

```text
角色：代码专家

职责：
负责真实代码仓库中的代码分析、实现、调试、测试和重构。

Workspace：
...

任务：
...

工程原则：
...

验收要求：
...
```

---

# 十一、顺手修复现有 Prompt 污染

当前通用任务编译中存在偏法律工作的要求，例如：

```text
引用法条……
引用案例……
```

这类要求不应该继续发送给：

```text
码农
代码专家
代码架构师
```

0.6.0 应把要求分成：

```text
legal
engineering
general
```

但不要建立复杂 Profile 系统。

最薄实现可以是在模板或 definition 上增加：

```text
domain: legal | engineering | general
```

如果不想新增字段，也可以先由内置模板决定。

建议优先后者。

---

# 十二、Codex Provider 不成为硬依赖

Workspace Profile 不负责安装：

```text
@deepseek-ai/dsh-subagent-codex
```

官方 Codex Backend 是独立能力。DSH 官方目前允许多个 Subagent Provider 在同一个 `ctx.subagents` 注册表中并存。

因此：

```text
Workspace Profile
      │
      ├─ spawn 可用
      │
      └─ codex provider 可用？
               │
           yes / no
```

如果没有安装：

```text
代码专家
Codex 后端未安装
```

不得：

```text
自动改成 DeepSeek
自动 fallback 到码农
偷偷安装 Codex
```

用户仍然可以使用码农。

---

# 十三、Codex 权限原则

Workspace Profile 不替用户提升 Codex 权限。

官方 Codex Provider 当前有独立 `permissionMode`，并由 Provider 管理 Codex 的非交互审批及 sandbox。

Workspace Profile：

```text
只检测是否存在 codex backend
```

不负责：

```text
修改 Codex 登录状态
写入 API Key
修改 CODEX_HOME
改变全局 sandbox
自动开启危险权限
```

如果 Codex 当前权限无法修改 Workspace：

> 明确返回执行失败原因。

不得自动切换到：

```text
dangerously-bypass-approvals-and-sandbox
```

---

# 十四、设置页 UI

Subagent 编辑器增加：

```text
执行方式
```

提供：

```text
DSH 子代理
Codex
```

选择：

### DSH 子代理

继续显示：

```text
Provider
Model
Reasoning
```

### Codex

隐藏：

```text
Provider
Model
Reasoning
```

改为显示：

```text
执行后端：Codex
模型：跟随 Codex 原生配置
```

并显示状态：

```text
Codex 后端可用
```

或者：

```text
Codex 后端未安装
```

---

# 十五、内置模板

0.6.0 的 Subagent Template 至少保留 / 增加：

```text
律师助理
独立评审员
码农
代码专家
代码架构师
```

其中：

```text
码农
```

继续使用原来的模板。

新增：

```text
代码专家 → backend: codex
代码架构师 → backend: spawn + GPT-6.1 Sol + high
```

不删除任何用户已有模板。

---

# 十六、增加 `@子代理` 输入源

利用 DSH 现有 Input Trigger 架构注册新的：

```text
trigger: '@'
name: 'workspace-subagents'
```

不要修改 DSH Composer。

不要 fork DSH UI。

不要自己实现浮层。

Workspace Profile 只作为一个新的 `@` Source。

---

# 十七、@ 菜单行为

用户在消息开头输入：

```text
@
```

出现一个新分组：

```text
工作区子代理

码农
coding
日常代码开发和简单工程任务

代码专家
code-expert
Codex · 仓库实施、调试和测试

代码架构师
code-architect
GPT-6.1 Sol · High · 架构与代码审查

律师助理
assist
案件材料处理……

独立评审员
reviewer
独立法律审查……
```

只显示：

```text
当前 Workspace
+
enabled === true
```

的 Subagent。

---

# 十八、Name 与 Key 双搜索

Candidate：

```text
name = key
label = 中文名称
```

因此：

```text
@码农
```

可以找到：

```text
coding
```

输入：

```text
@coding
```

也可以找到同一个 Subagent。

内部身份永远使用：

```text
key
```

显示使用：

```text
name
```

---

# 十九、直接调用只允许消息开头

必须坚持：

```text
@代码专家 修这个 Bug
```

→ 直接调用。

但：

```text
我觉得可以让 @代码专家 看看
```

→ 不触发直接调用。

这样避免正常聊天里提到 Agent 时意外执行。

Input source：

```text
position !== leading
```

时不返回 Workspace Subagent Candidates。

---

# 二十、@ 调用不创造第四套执行逻辑

`@子代理` 不直接实现自己的 Dispatcher。

推荐复用现有：

```text
/agent
```

调用链。

即：

```text
@代码专家 修复这个 bug
```

前端进入 CommandClaim：

```text
token:
@代码专家

submit(args):
/agent code-expert <args>
```

最终仍然：

```text
/agent
 ↓
SubagentDispatcher
```

因此：

```text
模型自动调用
/agent
@子代理
```

执行语义完全一致。

---

# 二十一、为什么复用 CommandClaim

可以直接获得 DSH 已有的：

```text
输入状态管理
提交生命周期
错误提示
Session 定位
命令执行记录
Enter 行为
Draft 保留
```

不用 Workspace Profile 自己实现：

```text
Composer submit
RPC dispatch
错误通知
输入清除
```

保持插件足够薄。

---

# 二十二、Subagent Candidate 数据来源

浏览器不能自己推断当前 Workspace 有哪些 Subagent。

增加一个只读 Remote：

```text
subagentsForSession
```

输入：

```js
{
  sessionId
}
```

返回：

```js
[
  {
    key,
    name,
    description,
    backend,
    routeLabel
  }
]
```

只返回启用项。

不返回完整 Policy。

不返回无关设置。

---

# 二十三、@ Source 缓存

不应该每键入一个字符都 Remote 一次。

每个 Session：

```text
首次 warm
    ↓
读取当前 Workspace Subagent
    ↓
缓存 Candidate 列表
```

后续：

```text
@
@代
@代码
```

全部本地过滤。

以下情况失效：

```text
Subagent 新增
Subagent 删除
启用/禁用
名称修改
Key 修改
Backend 修改
Workspace 切换
连接 reset
```

---

# 二十四、直接输入支持

不仅支持菜单点击。

还要支持：

```text
@码农 xxx
@coding xxx

@代码专家 xxx
@code-expert xxx

@代码架构师 xxx
@code-architect xxx
```

因此实现：

```text
matchSpace
matchEnter
lexicon
```

使手打和菜单 Pick 行为一致。

---

# 二十五、重名处理

Key 必须唯一。

Name 可以允许重名，但：

```text
@同名中文名称
```

如果对应多个 enabled Subagent：

> 不猜测，不直接执行。

提示用户使用：

```text
@key
```

例如：

```text
@code-expert
```

---

# 二十六、自动路由保持不变

K3 不因为增加 `@` 而失去 Supervisor 能力。

用户普通说：

```text
帮我修一下 KDocs Sidebar
```

仍然：

```text
用户
 ↓
K3
 ↓
K3 根据 Subagent Directory 判断
 ↓
码农 / 代码专家 / 代码架构师
```

用户明确：

```text
@代码专家 修一下 KDocs Sidebar
```

才：

```text
用户
 ↓
代码专家
```

即：

> 普通语言 = Supervisor Mode  
> `@Agent` = Direct Mode

---

# 二十七、推荐的 K3 路由语义

不要写死关键词。

依靠三个 Agent 的职责描述形成语义路由。

### 码农

偏：

```text
简单
高频
局部
低风险
低成本
```

### 代码专家

偏：

```text
真实实施
多文件
调试
测试
仓库修改
复杂 Bug
```

### 代码架构师

偏：

```text
方案
架构
审查
根因
复杂权衡
第二意见
```

这已经足够。

暂时不增加独立 Router。

---

# 二十八、建议修改文件

## `src/subagent-registry.js`

增加：

```text
backend
```

并增加两个模板相关定义。

保留原 `coding`。

---

## `src/subagent-dispatch.js`

核心改动：

```text
固定 spawn
```

变成：

```text
按 definition.backend dispatch
```

新增：

```text
buildSpawnRequest()
buildCodexRequest()
```

---

## `src/policy.js`

增加 backend 校验。

规则：

```text
undefined → spawn
spawn → provider/model required
codex → provider/model not required
```

---

## `src/model-catalog.js`

只对：

```text
backend === spawn
```

执行 DSH model route validation。

Codex 不进入 LLM Catalog 校验。

---

## `src/profile-runtime.js`

Subagent Directory 中加入执行信息。

例如：

```text
代码专家（code-expert）
职责：……
执行：Codex
```

和：

```text
代码架构师（code-architect）
职责：……
执行：GPT-6.1 Sol · High
```

这样 K3 能理解区别。

---

## `src/remote/invocations.js`

增加：

```text
subagentsForSession
```

---

## `src/remote/operations.js`

实现：

```text
Session
→ Workspace
→ Policy
→ enabledSubagents()
→ mention catalog
```

---

## `typert.remote-client.js`

同步新的 Remote Contract。

继续由：

```text
remote-contract.test.js
```

保证 Host / Client 不漂移。

---

## `client.js`

这是本次前端主要修改点。

增加：

```text
Workspace Subagent @ Source
```

负责：

```text
warm
candidates
onPick
matchSpace
matchEnter
lexicon
```

并复用：

```text
remote.commands.execute('/agent ...')
```

执行任务。

---

# 二十九、测试计划

必须新增以下测试。

### 旧版兼容

```text
没有 backend 的旧 Subagent = spawn
```

### 码农回归

确认：

```text
coding
```

仍然走原：

```text
spawn + DeepSeek
```

这是 0.6.0 必须单独做的 regression test。

### Codex

确认：

```text
code-expert
```

调用：

```text
subagents.start('codex')
```

并且 payload 不包含：

```text
agentOptions
persona
maxDepth
```

### 架构师

确认：

```text
code-architect
```

仍然走：

```text
spawn
```

且：

```text
reasoningEffort = high
```

### @ Candidate

确认：

```text
@
@代码
@code
```

能够正确过滤。

### @ Direct

确认：

```text
@代码专家 fix bug
```

最终转换为：

```text
/agent code-expert fix bug
```

### inline 安全

确认：

```text
请让 @代码专家 看看
```

不会直接 dispatch。

### Disabled

禁用子代理以后：

```text
@
```

不得再显示。

### Name Collision

两个相同 display name：

```text
@名称
```

不得猜测。

Key 调用仍正常。

### Backend Missing

没有安装 Codex：

```text
@代码专家
```

返回清晰错误。

不得 fallback 到：

```text
码农
DeepSeek
```

---

# 三十、验收场景

0.6.0 发布前至少手工完成以下真实测试：

```text
@码农
修改一个简单代码问题
→ DeepSeek Spawn

@代码专家
修改一个真实插件问题并运行测试
→ Codex

@代码架构师
审查这次修改
→ GPT-6.1 Sol High
```

随后测试自动模式：

```text
直接告诉 K3：
“这个插件白屏，你处理一下。”

观察 K3 是否能根据职责选择合适工程 Agent。
```

---

# 三十一、本版本明确不做

0.6.0 不做：

```text
删除或弃用码农
自动把码农迁移成 Codex
Claude Code Backend
Codex 多轮会话续接
多 Agent Team
自动链式调用
复杂 Router
Codex 登录管理
Codex 模型管理
Codex Token 统计
Agent 权重评分
自动成本路由
后台任务编排
工程 Dashboard
```

官方 Codex Provider 当前本身也是以一次性独立任务为主，所以本版本不应在 Workspace Profile 上方再人为做一套 Codex 会话持久化。

---

# 三十二、推荐开发顺序

### Phase 1：数据模型兼容

完成：

```text
backend
旧数据默认 spawn
schema validation
```

首先保证 0.5.0 零回归。

### Phase 2：Dispatcher Backend

完成：

```text
spawn
codex
```

先让：

```text
/agent code-expert xxx
```

真正能够启动 Codex。

此阶段不碰 UI。

### Phase 3：三个工程模板

确认：

```text
码农
代码专家
代码架构师
```

三者职责和路由正确。

### Phase 4：设置页

增加：

```text
Backend
Codex availability
条件模型字段
```

### Phase 5：@ Subagent

注册 Input Trigger Source。

先实现菜单 Pick：

```text
@ → 选择 Agent
```

再实现：

```text
@name
@key
```

手工直接输入。

### Phase 6：测试与文档

完成：

```text
回归
dispatcher
Codex
@ trigger
collision
disabled
missing backend
```

最后更新：

```text
README
CHANGELOG
MILESTONE-0.6.md
```

---

# 三十三、0.6.0 最终架构

最终 Workspace Profile 应保持非常简单：

```text
                         用户
                          │
                ┌─────────┴─────────┐
                │                   │
             普通输入             @直接指定
                │                   │
               K3              Workspace @ Source
                │                   │
     workspace_subagent          /agent
                │                   │
                └─────────┬─────────┘
                          │
                 SubagentDispatcher
                          │
              ┌───────────┴───────────┐
              │                       │
            spawn                   codex
              │                       │
    ┌─────────┼─────────┐             │
    │         │         │             │
   码农     律师助理   架构师        代码专家
    │         │         │             │
   DS        DS     GPT-6.1 Sol      Codex
                         High
```

核心原则：

> Workspace Profile 决定"有哪些专家、什么时候可以调用"。

> DSH Subagent 系统决定"子代理怎么运行"。

> Codex 官方 Backend 决定"Codex 怎么执行"。

> 用户通过 `@` 保留直接指定专家的控制权。

> K3 继续作为默认 Supervisor。

> 原来的"码农"继续是一等工程角色，而不是兼容遗留角色。
