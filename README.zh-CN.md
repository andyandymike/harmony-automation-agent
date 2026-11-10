# Harmony Automation Agent

[English](README.md)

让 AI 编程助手通过原生 HDC / UiTest **观察、操作和验证鸿蒙应用**。

当前版本为 **0.1.0a2，开发 alpha**。使用 Python 3.10+，运行时仅依赖标准库；基础流程不需要 Appium、视觉模型或模型 API key。尚未发布到 PyPI。请结合 [开源前检查](docs/publication-review-2026-11-10.md)、[本版设备验证报告](docs/validation-alpha2.md)、[CHANGELOG](CHANGELOG.md)、[兼容性矩阵](docs/compatibility.md) 和 [发布准备状态](docs/release-readiness.md) 查看实际结果。

2026-11-03，在专用 API24 测试模拟器完成小艺输入法基础模式及 26 键布局初始化后，普通和 native 两个真实 TextInput 的中文写入、替换、清空共 6 次读回均通过。单次约 4.17–6.66 秒；这些是特定控件的功能样本，不是通用成功率。输入仍标为实验性，完整 Agent 任务与候选版验证分别记录。

2026-11-10 开源前检查的离线回归 **150 项通过**，包含新增的滚动目标校验回归。2026-11-03 记录的设备 smoke 为 **40 步通过、0 失败、1 项跳过**，耗时 85.641 秒；本次代码修改后未重跑设备流程。普通输入框的单独检查已记录，不能将它替代 smoke 中跳过的独立 IME 套件。历史设备、Agent 任务与构建信息见 [本版验证报告](docs/validation-alpha2.md)，本次离线验证与包信息见 [开源前检查](docs/publication-review-2026-11-10.md)。

上一版 0.1.0a1 的 112 项离线测试、27 步设备流程及输入阻塞记录保留在 [历史验证报告](docs/validation-alpha.md)，不作为 alpha2 的新测试结果。

## 功能范围

- 环境检查、设备枚举、明确选择设备并接入会话。
- 解析 UiTest 布局，保留业务文本、输入值、选中状态及窗口信息。
- 通过稳定选择条件或当前观察帧的引用定位目标。
- 打开应用、点击、基础滚动、返回、截图；文本输入当前标为实验性。
- 等待明确条件，或将动作与预期结果放进同一次请求。
- 结构化结果、明确错误和本地证据，便于外层 Agent 处理。

当前聚焦一条原生执行路径。MCP、视觉断言、流程录制、自动恢复及跨崩溃回执服务仍在后续计划中。

## 前提

1. Python 3.10 或更高版本。
2. 通过官方 DevEco / HarmonyOS Command Line Tools 安装 HDC。
3. 已启动的鸿蒙设备或模拟器，设备已解锁并完成调试授权。
4. 要操作的应用已安装。工具不会替代工程构建、签名和设备授权。

主机平台、HDC 版本和 Harmony/API 的组合需要逐项验证。离线 CI 可在 Windows / Linux 运行，不代表所有设备组合均已支持。

## 安装与环境检查

先获取源码，再在项目根目录创建独立环境：

```powershell
git clone https://github.com/andyandymike/harmony-automation-agent.git
cd harmony-automation-agent
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install .
.\.venv\Scripts\harmony-agent.exe help
```

后续示例使用 `harmony-agent` 简写；环境未激活时，在 Windows 使用 `.\.venv\Scripts\harmony-agent.exe`。安装时构建工具可能需要取得 setuptools；运行时没有第三方 Python 依赖。若已有本版 wheel，可在同一环境中离线安装：

```powershell
.\.venv\Scripts\python.exe -m pip install --no-index --no-deps .\dist\harmony_automation_agent-0.1.0a2-py3-none-any.whl
```

wheel 需要来自本版构建，不要用旧版本文件名代替验收。如果当前环境不能构建安装，可直接从源码运行：

```powershell
$env:PYTHONPATH = "src"
python -m harmony_agent help
```

下文的 `harmony-agent` 均可替换成 `python -m harmony_agent`。

HDC 已在 PATH 时无需额外配置。否则指定实际文件位置：

```powershell
$env:HARMONY_HDC = "C:\HarmonySDK\toolchains\hdc.exe"
harmony-agent doctor --json
harmony-agent devices --json
```

也可以设置指向 HDC 所在目录的 `HDC_HOME`，或单次传入 `--hdc <完整路径>`。请以 `doctor` 的实际检查结果定位缺少工具、无设备、未授权或服务异常。设备列表为空不表示可以继续执行设备操作。

`doctor` 成功执行表示诊断命令已完成；还要检查返回的 `data.ready`。常见环境问题、协议约束和输入法前置条件见 [兼容性与排障](docs/compatibility.md)。

### 升级与卸载

升级时在同一环境安装明确选定的新 wheel，然后检查 `--version --json` 和 `schema --json`。移除工具使用：

```powershell
.\.venv\Scripts\python.exe -m pip uninstall harmony-automation-agent
```

卸载 Python 包不删除 HDC、SDK、应用或已有 `.harmony-agent` 状态和证据。换版本前保留有用报告，重新建立会话并观察设备，不沿用旧进程或旧观察帧的 ref。

## 第一次操作与验证

以下示例使用项目的 [fixture-v2](docs/fixture.md)。先按照该文档构建、安装测试应用。将 `YOUR_DEVICE_ID` 换为设备枚举中明确选定的完整 ID。

```powershell
harmony-agent attach --device YOUR_DEVICE_ID --session demo --json
harmony-agent open com.andyandymike.harmonyautomation.fixture --ability EntryAbility --session demo --json
harmony-agent observe --session demo --json
harmony-agent find "Increment" --session demo --json
harmony-agent press id=fixture.reset --session demo --json
harmony-agent wait id=fixture.counter --property text --equals "Counter: 0" --timeout-ms 5000 --session demo --json
harmony-agent press id=fixture.increment --session demo --json
harmony-agent wait id=fixture.counter --property text --equals "Counter: 1" --timeout-ms 5000 --session demo --json
harmony-agent screenshot --session demo --json
harmony-agent detach --session demo --json
```

快速开始使用计数器演示操作和验证。输入测试需要先完成设备的输入法初始化；当前验证范围及限制见 [CHANGELOG](CHANGELOG.md) 和 [fixture 说明](docs/fixture.md)。

### 实验性输入与本地副作用

两个 fixture 输入框都是真实 `TextInput`：`fixture.input` 使用普通软键盘行为，`fixture.input.native` 设置了 `enableKeyboardOnFocus(false)`。alpha1 在首次隐私引导前被阻塞；alpha2 测试中完成小艺基础模式及 26 键布局设置后，两者的中文写入、替换和清空均通过读回。关闭软键盘展示本身不能跳过输入法初始化。该验证使用原生文本注入，不代表拼音组合、软键盘候选、所有编辑器动作或其他设备均已验证。

在已完成输入法配置、已接入会话并打开 fixture 的设备上，可执行：

```powershell
harmony-agent fill id=fixture.input.native "你好 Harmony 123" --session demo --json
```

设备上的原生 `uiInput inputText` 会追加文本，空字符串也不能用来清空。CLI 的 `fill` 因此执行：点击目标 → 验证焦点 → 必要时 Ctrl+A → 再确认焦点 → Delete → 验证为空且焦点仍正确 → 原生文本注入 → 读回验证最终值。字段已经为空时跳过清空按键；删除或插入前失去焦点时停止。输入子步骤共享预算，默认 15 秒，可用 `--timeout-ms` 指定；独立 `wait` 默认仍为 5 秒，动作内 `expect.timeoutMs` 是独立的断言预算，默认 5 秒。

这一流程包含多步，输入失败时原内容可能已被清空，不能假设所有改动会回滚。未知下发结果后应重新观察。原生 Unicode 或长文本注入路径可能覆盖**设备剪贴板**，当前不承诺恢复原剪贴板内容；这属于本地操作的副作用。

结果中的 `timings.actionMs` 包含动作阶段的输入准备和内部验证，不应解释为纯输入命令的派发时间。

会话按名称保存；每次命令使用相同的 `--session`。设备接入和释放不等于启动、关闭或重置模拟器。

## 动作与结果一起表达

为避免终端 JSON 引号差异，建议 Agent 使用 UTF-8 请求文件。将下面内容保存为 `increment.json`：

```json
{
  "command": "press",
  "input": {
    "session": "demo",
    "target": "id=fixture.increment",
    "expect": {
      "selector": {"id": "fixture.counter"},
      "property": "text",
      "equals": "Counter: 1",
      "timeoutMs": 5000
    }
  }
}
```

确保 demo 会话已接入且应用已打开，先重置计数器，然后运行：

```powershell
harmony-agent press id=fixture.reset --session demo --json
harmony-agent --request increment.json --json
```

动作命令也支持 `--expect <JSON>`；精确字段和有效参数以安装版帮助及 schema 为准：

```powershell
harmony-agent help press
harmony-agent schema --json
```

## Agent 使用约定

面向外层 Agent 的简短调用流程见 [Agent usage](docs/agent-usage.md)，操作入口见 [Agent operating guide](docs/agent-operating-guide.md)。项目提供 CLI 调用指南，暂未附带可安装的 Agent Skill。

- `--json` 模式的 stdout 只输出 JSON；诊断日志写入 stderr。错误使用非零退出码。
- `success` 表达命令结果；业务结果是否被证明，需要看独立的断言结果。未请求断言时不能声称业务验证通过。
- `id=...`、`text=...`、`type=...` 为精确选择条件。多个匹配是需要消歧的错误，工具不会随意点击第一个。
- `@...` 引用仅属于其观察帧。可能改变界面的操作会使旧引用失效；超时后也不要重用。
- 紧凑观察仍应保留业务状态；注意 `quality` 中的截断和未知字段，不把未输出当作不存在。
- 动作下发结果为 `unknown` 时先重新观察和检查后置条件。不要盲目重复提交、增加计数等操作。
- 所有写操作只对明确选择的设备执行。本工具的协调机制不阻止用户或其他自动化工具同时操作设备。

状态和证据默认保存在当前目录的 `.harmony-agent`；可通过 `--state-dir <目录>` 指定其他位置。截图、树和输入相关信息可能含业务数据，分享前自行检查。工具不自动上传诊断数据。

## 测试与贡献

不需要设备即可运行解析、协议、受控传输及其他离线测试：

```powershell
$env:PYTHONPATH = "src"
python -m unittest discover -s tests -v
```

设备 smoke 和中文输入验证需要实际设备，不能由 mock 结果代替。请参阅 [CONTRIBUTING](CONTRIBUTING.md)、[fixture](docs/fixture.md) 和 [首个架构决策](docs/adr-0001-native-python.md)。

## 来源与许可

新 CLI、协议和原生执行代码为本项目实现，设计参考了 Playwright CLI、agent-device、Midscene 及 OpenHarmony 的公开接口。未将这些项目作为运行时必需依赖。

fixture 工程基于项目所有者的 [harmony-automation](https://github.com/andyandymike/harmony-automation/tree/ddaecb946c59d76648bfbb5ffa6b2273de83272f/fixture-app) 进行扩展，来源与构建边界见 [fixture 文档](docs/fixture.md)。官方 SDK、模拟器镜像与签名材料不随源码发布。

本项目代码、文档及 fixture 脚手架和资源统一采用 [MIT License](LICENSE)。项目所有者已确认复用材料的版权归属及 MIT 开源授权，原始来源记录保留在 [来源与分发边界](docs/source-provenance.md)。
