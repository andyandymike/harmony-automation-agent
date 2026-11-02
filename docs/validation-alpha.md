# 0.1.0a1 验证记录

日期：2026-11-02。此记录描述本地开发 alpha；没有宣称通过所有 M0/M1 发布门槛。

## 环境

Windows、Python 3.12.10、HDC 3.2.0d、UiTest 6.0.2.3、API 24 / HarmonyOS 6.1.1 模拟器，4 CPU、4 GB 内存、1256 × 2760 分辨率。fixture-v2 从本项目源码构建，使用本地测试签名安装；源码包不包含签名私钥、设备 UDID 或已签名 HAP。

## 离线与安装

- `PYTHONPATH=src python -m unittest discover -s tests -v`：112 项通过，主流程复核 1.675 秒。
- 覆盖 JSON 契约、未知状态、截断与错误树、歧义目标、旧引用和回收列表行、断线、跨进程锁释放、原生命令超时、部分执行、输入焦点转移与错误证据。
- wheel 使用本地 setuptools 构建；隔离 venv 中安装并运行 `harmony-agent help`、`--version` 成功。运行时无第三方 Python 依赖。
- CI 配置已提供；尚未执行远端 CI，也未在其他 Python/操作系统组合进行设备验证。

## 实际设备流程

可复现脚本为 `scripts/device-smoke.py`，摘要见 [validation-device-smoke.json](validation-device-smoke.json)。摘要不包含设备标识、用户路径或屏幕文本；详细树与截图保存在运行者自己的状态目录。

默认测试覆盖打开 fixture、READY/Reset/Counter、旧 ref 拒绝、开关、延迟结果、同名按钮歧义与按容器选择、滚动到底、截图、故意失败断言的证据和 detach。预期拒绝被视为该拒绝测试通过，不代表动作成功。输入必须以 `--include-input` 单独启用，skip 不算通过。

实际执行耗时 43.0 秒：**27 个步骤 pass、0 fail、2 skip**。步骤数包含准备观察、滚动与收尾，不能当作 27 个独立业务任务。

普通交互、开关、600 ms 延迟结果、同名按钮按容器定位均通过；旧 ref 与歧义目标在派发前拒绝。3 次滚动后读到 `END OF FIXTURE`。故意错误的断言返回 `ASSERTION_TIMEOUT` / `failed`，观察与截图证据均存在。两个 skip 分别为 native 输入和普通 IME 输入；正向输入未通过验收的原因见下文。

## 速度样本

以下为同一模拟器上连续五轮 `Agent.execute` 墙钟耗时，包含设备连接/会话检查、HDC 采集、本地状态写入；点击项还包含新鲜目标观察与结果断言。未包含 CLI 进程冷启动或模型推理。未做真机、并发或跨工具比较，也不据此计算通用准确率或 p95。

| 轮次 | observe（ms） | press + Counter 断言（ms） | 断言 |
| --- | ---: | ---: | --- |
| 1 | 1117.04 | 2307.59 | passed |
| 2 | 1107.56 | 2278.28 | passed |
| 3 | 1034.83 | 2257.27 | passed |
| 4 | 1058.40 | 2316.33 | passed |
| 5 | 1100.41 | 2315.96 | passed |

中位数：observe 1100.41 ms；press + 断言 2307.59 ms。五轮均符合 Counter 的确定性期望，但不是对任意应用的成功率承诺。

## 输入未通过验收

普通 `fixture.input` 的点击会触发小艺输入法首次引导。新增真实 `TextInput` 控件 `fixture.input.native` 设置了 `enableKeyboardOnFocus(false)`，仍观察到按键后或点击后进入输入法引导。没有自动同意基本/全量隐私选项。

本轮返回过 `INPUT_FOCUS_BLOCKED`、`INPUT_CLEAR_FAILED` 和早期输入读回失败，均未误报文本输入成功；失败保留截图与观察。中文、替换、清空的正向设备验收因此仍为 **BLOCKED**，不能用模拟测试替代。

已核对原生实现：`uiInput inputText` 追加，空串不清空。alpha 的 `fill` 明确验证焦点、必要时全选/删除并确认空值、输入、确认最终值；共用剩余预算，失焦后不插入，超时不重复派发。Unicode/长文本可能使用设备剪贴板，失败可能已改变原文，不承诺恢复。

相关源码：

- [OpenHarmony 6.0 ui_input.cpp](https://github.com/openharmony/testfwk_arkxtest/blob/OpenHarmony-6.0-Release/uitest/input/ui_input.cpp)
- [OpenHarmony 6.0 ui_driver.cpp](https://github.com/openharmony/testfwk_arkxtest/blob/OpenHarmony-6.0-Release/uitest/core/ui_driver.cpp)
- [OpenHarmony 6.0 widget_operator.cpp](https://github.com/openharmony/testfwk_arkxtest/blob/OpenHarmony-6.0-Release/uitest/core/widget_operator.cpp)

## 后续验收

使用完成输入法初始化的测试设备验证中文、替换、清空与剪贴板行为；增加真机组合和外部安装试用。正式 Skill、MCP、视觉适配、录制、自动恢复与公共发布继续按计划推进。
