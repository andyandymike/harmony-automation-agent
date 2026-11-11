# Harmony Automation Agent

[English](README.md)

通过原生 HDC / UiTest 观察、操作和验证 HarmonyOS 应用的开源工具。可以在终端、自动化脚本或 AI Agent 中使用。

项目提供 Python CLI、可移植的 Agent Skill 和可选的本地 stdio MCP 适配器。它们共用基于 Python 标准库的执行核心；运行时不调用模型，也不需要 Appium 服务、视觉模型或模型 API Key。

**0.1.0a9 是尚未发布的开发预览版，未发布到 PyPI。** 已验证环境见[兼容性](docs/compatibility.md)，本地结果见 [alpha9 验证记录](docs/validation-alpha9.md)，版本历史见 [CHANGELOG](CHANGELOG.md)。项目默认文档语言为英文。

## 功能

- 读取原生 UI 树、定位控件，返回紧凑或语义化的页面视图。
- 打开应用、点击、滚动、输入文字，并验证可观察的结果。
- 执行包含条件、循环和明确完成目标的有界计划。
- 用一次 `execute` 完成已知流程，包括初始条件检查、最终验证和会话清理。
- 在已知流程内绑定页面实时值，减少逐页读值、填写时与模型往返。
- 保存本地执行记录，无需连接设备即可检查已保存的证据。
- 协调单一设备执行者，允许可选的只读角色检查已有证据。

## 环境要求与安装

需要 Python 3.10+、官方 HDC 工具，以及已解锁、已授权调试且可使用 UiTest 的 HarmonyOS 真机或模拟器。目标应用需单独安装。文字输入还需要完成输入法初始化，并使用受支持的可编辑控件。

克隆仓库并创建环境：

```sh
git clone https://github.com/andyandymike/harmony-automation-agent.git
cd harmony-automation-agent
python -m venv .venv
```

Windows：

```powershell
.venv/Scripts/python.exe -m pip install .
.venv/Scripts/harmony-agent.exe --version --json
```

POSIX 主机：

```sh
.venv/bin/python -m pip install .
.venv/bin/harmony-agent --version --json
```

下文用 `harmony-agent` 代指该环境中的可执行文件。将 HDC 加入 PATH，或用 `HARMONY_HDC` 指定完整路径、`HDC_HOME` 指定所在目录，也可以传入 `--hdc PATH`。主机端安装成功并不代表已验证设备兼容性。

离线 wheel、环境配置、升级和卸载见[安装指南](docs/installation.md)，排障见[兼容性说明](docs/compatibility.md)。构建可选的 fixture 应用另需 SDK 和签名工具。

## 选择任务入口

页面结构和完整流程已明确时，使用 `execute`，提供准确设备 ID，以及包含应用范围明确的初始 `preconditions` 和最终 `goals` 的计划，两者都不能为空。它会连接或恢复会话、执行并验证任务，成功后自动分离会话；需要有意保留会话时使用 `--keep-session`。默认返回用于下一步判断的精简结果。根据已验证的流程契约调整[完整示例](skills/harmony-agent/references/workflows.md#complete-two-page-example)，将原始计划保存为 UTF-8 JSON 文件：

```sh
harmony-agent execute --device YOUR_DEVICE_ID --session task --plan-file .harmony-agent/workflow.json --json
```

新任务仍符合相同流程契约且已获授权时，直接复用已验证的计划文件；每次调用自动生成新的执行 ID。结果不确定时不能自动重试。需要探索或尚不了解当前页面时，先用 `start`，再用 `run` 执行明确的任务片段。

使用任务明确提供的设备 ID，或通过 `devices` 获取。`start` 一次完成会话连接或恢复，并返回当前页面与支持的计划契约；环境异常时再使用 `doctor` 排查。

```sh
harmony-agent devices --json
harmony-agent start --device YOUR_DEVICE_ID --session demo --json
harmony-agent detach --session demo --json
```

读取 `start` 返回的 `observation` 获取应用上下文、UI 节点和观察质量，后续需要新页面时使用 `observe`。连接和分离会话不会启动或重置设备。若要使用项目提供的示例控件，可构建并安装可选的 [fixture 应用](docs/fixture.md)。[本地流程说明](skills/harmony-agent/references/workflows.md) 提供实时数据绑定和精简执行结果的完整例子。

## 操作与验证

运行下例前，连接 `demo` 会话、打开 fixture 并重置计数器：

```sh
harmony-agent attach --device YOUR_DEVICE_ID --session demo --json
harmony-agent open com.andyandymike.harmonyautomation.fixture --ability EntryAbility --session demo --compact --json
harmony-agent press id=fixture.reset --session demo --compact --json
```

将以下内容以 UTF-8 保存为 `.harmony-agent/increment.json`：

```json
{
  "schemaVersion": "1",
  "command": "press",
  "input": {
    "session": "demo",
    "compact": true,
    "target": "id=fixture.increment",
    "expect": {
      "selector": {"id": "fixture.counter"},
      "equals": "Counter: 1"
    }
  }
}
```

```sh
harmony-agent --request .harmony-agent/increment.json --json
harmony-agent help press
harmony-agent detach --session demo --json
```

确认计数器结果时，需要检查断言是否通过。动作也会返回观察结果，可直接用于下一步判断。已通过的 `expect` 不需要再用 `wait` 重复验证同一条件。动作结果不确定时，应先重新观察，再决定是否重试。

完整已知任务使用 `execute`，已有会话中的有界片段使用 `run`。`execute` 默认返回 decision 结果；`run` 保持完整响应默认值，也接受 `output: "decision"`，两者均保留完整运行证据。`report` 和 `inspect` 读取已有证据，不采集设备页面。在同一次连续运行中，目标定位可以复用采集完成后不超过 1000 毫秒的页面；动作步骤的 `refresh: true` 会要求重新采集。结果含义和性能取舍见[执行指南](docs/execution.md)，单条命令见[请求示例](docs/agent-requests.md)。

## 接入 AI Agent

| 接口 | 用途 |
| --- | --- |
| CLI | 从终端、脚本或具有进程执行能力的 Agent 直接调用命令。 |
| Agent Skill | 向 Agent 提供命令契约、定位方式、观察结果复用和失败处理说明。 |
| 本地 stdio MCP | 保持工具进程连接，通过 MCP 使用同一执行核心。 |

从 [Agent 接入指南](docs/integrations.md)选择接口。仓库包含[完整 Skill](skills/harmony-agent/SKILL.md)、安装脚本和可选的宿主配置示例。wheel 包含 Python 运行时和 MCP 适配器；使用 Skill 时需单独安装。

单个 Agent 即可完成设备操作。[多 Agent 角色](docs/multi-agent.md)是可选模式：只读角色可解释已保存的页面或复核结果，设备动作由一个执行者负责。

## 限制与本地数据

控件必须通过原生 UI 树暴露足够的信息，才能定位和验证。视觉定位、事件监听、自主恢复和模型路由尚未实现。

文字输入仍属实验能力。多步骤 `fill` 失败时，先前的编辑可能已经生效；原生文本注入也可能覆盖设备剪贴板。使用前请阅读[输入行为](docs/agent-usage.md#input-limitations)。

动作确认与断言通过是两件事；命令成功也不等于计划任务成功或目标已经验证。`execute` 还需检查 `sessionCleanup`：失败、未知或主动让出控制的任务会保留会话，清理失败也不会撤销已完成动作。响应丢失时查询 `report RUN_ID`，不要重放流程。独立的 `workflowReceipt` 记录该次任务结束时的清理结论；记录缺失或无效表示清理状态未知，不表示应该重新执行任务。输出被截断、字段未知时，不能据此认定控件不存在。详见[执行结果](docs/execution.md#interpret-outcomes-separately)。

状态和证据默认保存在 `.harmony-agent/`，可用 `--state-dir` 更改位置。分享前应检查 UI 树、截图和输入数据。运行时不会自动上传诊断资料，但 Agent 宿主可能将工具结果发送给其模型。

## 文档

| 指南 | 内容 |
| --- | --- |
| [安装](docs/installation.md) | 环境要求、源码和 wheel 安装、升级及卸载 |
| [Agent 接入](docs/integrations.md) | CLI、Skill、MCP 和可选宿主示例 |
| [执行](docs/execution.md) | 有界计划、保存的证据、结果含义和效率 |
| [性能测量](docs/performance.md) | 时间线、测量边界和配对比较 |
| [Agent 使用](docs/agent-usage.md) | 定位、输入、错误处理和验证 |
| [Fixture 应用](docs/fixture.md) | 可复现的测试控件 |
| [兼容性](docs/compatibility.md) | 已验证环境与排障 |
| [发布准备](docs/release-readiness.md) | 验证记录和剩余发布工作 |

## 开发与贡献

欢迎提交问题、改进文档、提供合成复现用例或贡献代码。开发配置、检查方式和问题报告要求见 [CONTRIBUTING](CONTRIBUTING.md)。

设置 `PYTHONPATH=src` 后，运行离线测试：

```sh
python -m unittest discover -s tests -v
```

离线测试不需要设备或模型 API Key。设备检查应单独执行并记录。原生 Python 方案见 [ADR 0001](docs/adr-0001-native-python.md)。

## 许可证与来源

项目代码、文档、fixture 脚手架及资源均采用 [MIT 许可证](LICENSE)。项目所有者已授权复用材料按 MIT 分发，署名及设计参考见[来源说明](docs/source-provenance.md)。仓库不包含 SDK 二进制、模拟器镜像或签名材料。
