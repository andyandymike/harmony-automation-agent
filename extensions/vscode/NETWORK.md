# Network · 网络调试

## 从手机操作找到请求

1. 打开工作台的「网络调试」。在已选手机上打开调试签名的应用，然后点「开始采集」。插件会识别当前前台 App。指定其他应用时，展开「更多采集选项」。
2. 等到「采集中」再重现问题。复现结束后在原位置点「结束采集」。需要指定时长时，在「更多采集选项」中选择「定时采集」。
3. 等待读取结束后点「查看本次请求」。可以从这一批请求返回之前的列表。若结果为零，在所选应用中准备一个会触发 Network Kit 请求的操作，再次采集。

请求列表的「清空请求历史」会清除已保留的全部请求，可撤销。收藏的请求仍可在「收藏」中打开。用「多选」可批量收藏或移除请求。「全选」选中当前筛选结果，移除后可整批撤销。设备提前结束手动采集时，插件会显示「设备提前结束了采集」并读取设备已保存的结果。华为文档列出的手动采集上限为 3600 秒。 [华为 hiprofiler 文档](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/hiprofiler/)
4. 点列表旁的异常数量可筛出失败记录。输入 `status:503` 可查指定状态码，也可组合 `method:GET host:catalog.test`。要查正文，打开「查找内容」，选择「响应正文」，输入文字或正则，用上下箭头逐个查看命中。
5. 选择一条记录阅读请求、响应或耗时，用上下方向键切换记录，Home、End 到达列表首尾。要比较两次请求，点「多选」，依次勾选两条记录并点「对比请求」。先勾选的是请求 A，后勾选的是请求 B。返回列表可继续调整选择。经过网关的请求还可查看改写前后的差异，并从命中的规则名称进入编辑器。

## Find a request from a phone action

1. Open **Network**. Open the debug-signed app on the selected phone and choose **Start capture**. The plugin uses the foreground app. To choose another app, open **More capture options**.
2. Wait for **Capturing**, reproduce the interaction, then choose **End capture** in the same toolbar. To set a duration, choose **Timed capture** in **More capture options**.
3. After the trace has been read, choose **View this capture** to inspect just its requests. **Back to previous list** restores the earlier view. If the result is empty, prepare an action that triggers a Network Kit request in the selected app and capture again.

Choose **Clear request history** to remove the retained requests, with Undo available in the list. Saved requests stay in Favorites. Select multiple requests to favorite or remove them together. Select all applies to the filtered list, and one Undo restores the batch. If the phone ends a manual capture, the workbench labels it and reads the saved results. Huawei documents a 3,600-second device limit for manual capture. [Huawei hiprofiler documentation](https://developer.huawei.com/consumer/en/doc/HarmonyOS-Guides/hiprofiler/)
4. Filter by `status:503` or `method:GET host:catalog.test`. To find an error message, search the response body and step through the highlighted matches. To compare two exchanges, choose **Select multiple**, pick request A and then request B, and choose **Compare requests**. **Rule changes** shows what changed during a single gateway exchange.

## 留下一条失败请求，再改一个字段

1. 在请求列表或详情点星标。收藏保留这一次已脱敏的请求和响应。点「改名」可以写下故障名，点列表标题旁的「收藏」即可找回。历史只保留最近 500 条，收藏可跨工作区重开保留。详情「更多」里的「从历史移除」只处理历史记录，移除后可以撤销。
2. 打开 503 请求的「响应」，直接点正文里的属性名，例如 `retryAfter`。规则草稿带入方法、匹配路径、字段路径、类型和原值。在「新值」把数字 2 改成 5，用「预览历史匹配」核对变化。也可以选「移除字段」来删除属性。请求头、响应头与查询参数同样可以作为建规则的起点。
3. 想留到下次再试，可以取消勾选「启用」后保存规则；日后在规则列表点「启用」。规则编辑器会显示保存到哪个规则组。换规则组会收起原规则组的规则草稿，在当前窗口切回去可以接着编辑。规则的「更多」可复制、改名、调优先级、移除，规则列表会提供撤销最近一次移除的入口。

重发请求或编辑模拟响应时，可以在键值行里添加、改动、删除单个头部或参数。重发时同名查询参数可分行操作。JSON 字段编辑器支持对象、数组、文本、数字、布尔值和 null，可以逐项增删、撤销，也可以切到原文。

## Keep an exchange and edit one field

Star a request in the list or inspector to keep its retained request and response past the 500-entry history window. Name it in the inspector and use **Favorites** to find it again after reopening the workspace. Removing a history entry and removing its favorite are separate actions.

Click a JSON property, query parameter or header in a captured exchange to start a rule for that field. Change the typed value, preview the differences against history, then save to the displayed rule group. Clear **Enabled** to save it for later. The rule list supports editing, duplication, renaming, reordering and undoing the most recent removal. When editing a resend or response sequence, use key/value rows and the JSON field editor to add and remove individual entries. Repeated query parameters have separate rows when composing a request.

Open **Mock & rewrite** to create or import a rule group. The workspace starts with an empty list. Choose **Use for manual mocking** to apply a group to new gateway traffic. Turn it off in **Test gateway → Turn off manual mocking**. Select the group title to rename it. Rewrite rules and response sequences appear together in matching order. Select a rule to expand its editor, use its switch to enable it, or drag its handle to change priority. The first enabled match handles a new request. Use **Manage rule group** to duplicate, export or delete a group. To reuse a captured JSON response, open **More** in the request details and choose **Create response sequence**.

## 用规则组管理模拟与改写

打开「模拟与改写」新建或导入规则组。新工作区的列表为空。选中一组查看规则后，可点 **用于手动模拟** 让网关处理新请求。需要关闭时，到 **测试网关 → 关闭手动模拟**。右侧按优先级显示改写规则和顺序响应。点规则行展开编辑，点开关独立启停，拖动左侧把手调整优先级。组内规则支持全选，可批量启用、停用或移除，移除后可整批撤销。网关收到请求时，首条匹配的已启用规则生效。

点组标题即可重命名，按 Enter 保存、Esc 取消。可以新建或导入规则组，在「管理规则组」中复制、导出或删除。关闭手动模拟后，网关继续转发到已配置的上游，并保留每条规则的启停状态。若要从已采集的请求生成顺序响应，在请求详情的「更多」里点「创建顺序响应」，检查返回状态、正文和顺序，然后保存规则组。

## 从一次请求建立改写规则

1. 在请求详情点「创建规则」。编辑器会带入 HTTP 方法和精确路径。需要调整范围时，展开「修改匹配条件」。要把查询参数纳入匹配，选择完整 URL。
2. 在「命中后怎么处理」里选「直接返回模拟响应」或「修改指定字段」。例如把查询参数 `lang` 设为 `zh`，保留 `page=2`。「更多处理方式」提供替换整个请求、替换上游响应和转发到其他路径。
3. 在「保存到规则组」选择目标组和规则名称。可先点「预览历史匹配」查看预计改动，再点「保存规则」。预览使用已采集的记录。保存后会打开目标组。网关按「网关使用中」的规则组处理新请求。
4. 在「模拟与改写」里的「测试网关」配置路由，填写电脑上的开发服务源地址，例如 `http://127.0.0.1:3000`，然后启动网关。手机测试构建可使用「连接手机」，将其 API 基址设为界面显示的手机地址。上游留空时可使用本地响应与顺序响应。每个工作区单独保存上游地址，分享规则文件后由接收方重新配置。

**编辑并重发**会把你检查过的方法、相对路径、头和正文发到当前测试网关一次。结果里点「与原请求对比」即可查看两次响应的差异。原请求只保存在收藏中时也能对比。原生分析缺少 POST 正文时，需要提供测试正文或明确发送空正文。

## Build and check a rewrite

Select **Create rule** in a request’s details. The editor starts with the captured method and exact path. Open **Edit match conditions** to broaden the match or include the full URL. Choose **Return a mock response** or **Rewrite fields**, or open **More actions** to replace a whole request, replace an upstream response, or forward to another path. In **Save to rule group**, choose the destination group and name the rule. Saving opens that group so you can see the new rule in matching order.

Preview against retained exchanges to inspect the scope and expected changes. Preview sends no traffic and consumes no hits. To use the rule, enter your computer's development service origin (for example `http://127.0.0.1:3000`) under **Test gateway** in **Mock & rewrite**, then start the gateway. Forwarding uses this single loopback upstream. For phone requests, connect the phone and set the test build’s API base URL to the displayed phone address. Without an upstream the gateway can still serve local fixtures and sequential replies. Each workspace has its own upstream, so a teammate importing the rule group configures their own route.

**Edit and resend** opens an editor under the selected request. Send one request through the test gateway and compare the result with the original beneath the editor. A native POST capture may lack the original body. Supply a test body or explicitly choose to send an empty one.

## 在本机试一次

将下方示例保存成 JSON，在「模拟与改写」导入。选择 **用于手动模拟**，再启动测试网关。在匹配 `GET /items` 的顺序响应旁点「发送测试请求」。第一次返回 503，第二次返回 200 和空数组。可以从测试结果打开对应请求，重置命中次数后可从头再试。

点顺序响应行，展开后修改各次响应的状态码、延迟或内容。要一起修改多条，打开「管理规则组」里的「批量编辑顺序响应」。组名旁的「继续编辑草稿」会重新打开未保存的修改。「保存规则组」会更新工作区配置。要交付单独的 JSON 文件，在「管理规则组」里点「导出规则组」。

HDC 将所选设备的回环端口映射到电脑上的网关。测试构建需要支持设置 API 根地址并访问这个本地 HTTP 地址。命中本地响应规则的请求直接返回本地响应。

在 **测试** 打开可编辑的用例，在要开始模拟的位置点 **插入 → 启用规则组**，搜索并选中规则组。在结束该组模拟的位置选择 **关闭规则组**，从到达此处时已启用的组中选择关闭对象。多个组可以同时启用。同一规则组在一次启用区间内使用同一份快照和响应进度，关闭后可以重新启用。同一请求命中多个组时，最近启用的组优先。工作台按步骤切换规则，运行结束后恢复网关的手动配置。启用步骤保存在用例中，包含保存时的规则组快照。运行配置里的 **本次关闭规则组** 会跳过这次运行的规则组设置。

在 **管理规则组** 可以导出规则组 JSON，也可以把当前流程与规则组合在一个文件里。运行前应将测试构建的 API 根地址指向设备回环服务。

## Try a local request

Save the example below as JSON and import it in **Mock & rewrite**. Choose **Use for manual mocking**, then start the test gateway. Find the sequence for `GET /items` and send a test request twice. The first response is 503 and the second is 200 with an empty list. Open the exchange from its test result to inspect it. Reset hit counts to repeat the sequence.

Select a sequence to expand its editor and change a response’s status, delay or body. Switch to **Requests** to inspect an exchange, then return to the draft. **Save rule group** updates the workspace copy. Use **Manage rule group** and **Export rule group** to save a separate JSON file.

HDC maps the selected phone’s loopback port to the gateway on the computer. The build needs a configurable API base URL and support for local HTTP. Requests matching the local fixture receive their response directly from the gateway.

Open an editable case in **Tests** and choose **Insert → Enable rule group** where mocking should start. Search for a group and confirm it. Use **Turn off rule group** to choose a group that is active at that position. Several groups can be active together. Each group keeps its snapshot and response sequence until it is turned off. Turn it on again after that to start a new sequence. When more than one group matches a request, the most recently enabled group takes precedence. The workbench applies each change as it reaches the matching step and restores manual gateway settings when the run finishes. Each enable step saves a snapshot of the selected group. **Turn off the rule group for the next run** skips this case's group settings for one run.

Use **Manage rule group** to export the group JSON or bundle a workflow with the group. Configure the test build to use the device loopback base URL before running.

## 规则组示例 · Rule group example

这组规则中的顺序响应按 HTTP 方法和精确路径匹配。每次命中向后移动一步，用完后重复最后一步。`request` 可替换查询、请求头及 JSON 顶层字段。省略 `response.json` 时，服务会将修改后且已遮蔽常见凭据的请求字段回显给客户端，适合检查请求改写。

This sequential fixture matches its method and exact path. Each hit advances one step and the last step repeats. Use `request` to override query parameters, headers and top-level JSON fields. With `response.json` omitted, the client receives an echo of the effective request with common credential fields masked.

```json
{
  "version": 1,
  "name": "Catalog retry",
  "rules": [{
    "id": "catalog",
    "method": "POST",
    "path": "/catalog",
    "steps": [
      {"response": {"status": 503, "json": {"retry": true}}},
      {
        "request": {
          "query": {"locale": "en"},
          "headers": {"x-build": "sample"},
          "json": {"page": 2}
        },
        "response": {"status": 200, "delayMs": 250, "headers": {"x-scenario": "retry"}}
      }
    ]
  }]
}
```

## 已有记录 · Existing captures

有 HAR 文件时可以直接导入。对自有测试应用中已开启调试的 ArkWeb 页面，输入已转发到电脑的调试端口，再选择具体网页，随后在应用中重现操作。切换到另一网站时重新选择要观察的页面。已安装应用的原生 HTTP 明细需要该应用和设备的分析能力支持。来源列会标出 HAR、网页、原生采集或本机测试服务。

Import an existing HAR, or observe a debug-enabled ArkWeb page in a test build by entering its forwarded local debugging port and selecting the page. Perform the action after attaching. A top-level navigation to another origin ends that observation. Native HTTP detail depends on the profiling support of the app and device. The source column identifies imported HAR, web, native and local fixture records.

工作区保留最近 500 条记录，支持保留的正文上限为 96 KiB。原生、ArkWeb 和 HAR 可保留 JSON 或表单；网关还支持纯文本。其他类型显示可用元数据。常见凭据、Cookie 和能识别的个人资料字段会被遮蔽。导出或分享前核对业务自定义字段。

The workspace retains the latest 500 records, with up to 96 KiB per supported body. Native, ArkWeb and HAR records can include JSON or form data. The gateway also retains plain text. Other content types show the available metadata. Common credential fields, cookies and recognized personal fields are masked. Review application-specific fields before sharing.

真机原生采集使用调试签名应用 PID 的 Network Kit 事件，按设备时钟对齐操作时间。公开的 NetStack 记录包含方法、URL、请求头、响应头、状态码、可用响应正文和分段耗时。没有请求正文的记录会在详情中标明。采集结束后，列表还会显示同时间段可取得的 HiLog 时间、级别和标签。选择运行步骤或手机操作可筛选同期请求。

Native recording uses Network Kit events for the selected debug-signed app process. It aligns device timestamps with recorded actions. The public NetStack event carries the method, URL, headers, status, available response body and phase timings. Request body availability is shown in the detail view. HiLog entries show timestamp, level and tag when available. Selecting a step or phone action filters requests by temporal overlap.

采集中拔掉手机，设备上可能留有本次临时采集文件。重新连接后可开始新采集。同一扩展会话会在手机重连时核对并清理自己创建的旧网关映射。

Unplugging the phone during capture may leave that capture’s temporary files on the device. Reconnect to start a new capture. If the same extension session is still open, it checks and removes its own retired gateway mapping when the phone reconnects.
