# SnowLuma QQ 文件发送工具

让本机 AI Agent 把用户指定的文件，通过 SnowLuma 发给预先配置好的 QQ 收件人。

提供 **stdio MCP + CLI**：准备文件 → 发送 → 查询状态。文件内容由本机 QQ 后端读取上传；模型只接触文件名、大小、校验值和发送状态。工具不调用模型 API，也不需要模型密钥。

适合“生成报告后把文件发给我”这类个人秘书任务。它只处理文件发送，不接收群消息，不提供群管理或聊天记忆功能。

## 需要什么

- Node.js **24+**、npm。
- 已登录 QQ 且开启 OneBot HTTP 接口的 **SnowLuma**，在同一台电脑运行。
- 网关支持扩展动作 `upload_private_file`。它不是 OneBot v11 标准动作，后端版本会影响实际可用性。
- 网关进程能按**相同绝对路径**读取本工具的暂存文件；当前不做跨主机或容器路径映射。

本地原型已在 Windows + SnowLuma **2.1.1** 完成真实 PDF 私聊发送，收件人确认能打开文件。公开版增加了配置通用化和边界检查，以自动化测试验证；其他网关、版本和操作系统的真实 QQ 传输尚未验证。

本仓库不包含 SnowLuma、QQ 或它们的安装器，也不负责启动、更新、登录这些程序。请自行安装并遵守各自许可。本工具是独立项目，与这些项目及腾讯无隶属关系。

## 快速开始（PowerShell）

下载或克隆本仓库，进入目录：

```powershell
npm ci --ignore-scripts
New-Item -ItemType Directory -Force D:\file-sender-home, D:\agent-output
Copy-Item .\secretary.example.json D:\file-sender-home\secretary.json
```

编辑 `D:\file-sender-home\secretary.json`：将 `enabled` 改为 `true`，`recipientQQ` 填成**自己的收件 QQ 号字符串**；`gatewayUrl` 填本机网关地址；`sourceRoots` 仅允许专门存放待发送产物的目录。

```json
{
  "enabled": true,
  "recipientQQ": "YOUR_QQ",
  "gatewayUrl": "http://127.0.0.1:3000",
  "sourceRoots": ["D:/agent-output"]
}
```

`YOUR_QQ` 是占位符，必须替换才能运行。网关地址只接受 `127.0.0.1` 或 `[::1]` 的 HTTP 根地址，不接受域名、路径、查询参数或 URL 内凭据。

```powershell
$env:FILE_SECRETARY_HOME = 'D:\file-sender-home'
$env:ONEBOT_ACCESS_TOKEN = '填入你本机网关的访问令牌'
node .\src\cli.js --file D:\agent-output\report.pdf --prepare-only
```

此时只创建文件副本，尚未发出。记录返回的 `deliveryId`，按用户发送指令继续：

```powershell
node .\src\cli.js --send-id <deliveryId>
node .\src\cli.js --status <deliveryId>
```

也可以用 `--file <绝对路径>` 直接准备并发送。CLI 会在网络请求前打印记录 ID，中途退出后应先用该 ID 查状态。没有鉴权的网关可省略 `ONEBOT_ACCESS_TOKEN`；推荐启用网关鉴权。

Linux/macOS 的路径和环境变量语法需要相应替换。所有运行数据写在 `FILE_SECRETARY_HOME`；想节省系统盘空间，就把它和产物目录设在其他磁盘。

## 接入 MCP

只向**可信本机工作 Agent**开放。不要挂载到任意群成员或陌生人可以触发的聊天 Agent。

支持通用 stdio MCP 配置的客户端可参考：

```json
{
  "mcpServers": {
    "snowluma-file-sender": {
      "command": "node",
      "args": ["D:/tools/snowluma-qq-file-sender/src/mcp.js"],
      "env": {
        "FILE_SECRETARY_HOME": "D:/file-sender-home",
        "ONEBOT_ACCESS_TOKEN": "YOUR_LOCAL_GATEWAY_TOKEN"
      }
    }
  }
}
```

替换项目路径和令牌。客户端启动时须能找到 Node.js 24+；必要时把 `command` 写成 `node.exe` 的绝对路径。Codex 的 TOML 示例和 DeepSeek Harness 接入说明见 [Agent 流程](docs/AGENT_WORKFLOW.md)。

| 工具 | 用途 |
| --- | --- |
| `file_secretary_help` | 首次调用时读取流程 |
| `prepare_file({file})` | 校验指定文件并创建不可随源文件变化的副本，返回 ID |
| `send_file({deliveryId})` | 发送该副本，工具参数不能指定收件人 |
| `delivery_status({deliveryId})` | 读取持久化状态，不再上传 |

用户提示词示例：“把刚生成的 `D:/agent-output/report.pdf` 用 SnowLuma 发给我。”Agent 应准备并发送同一 ID，不能先把 PDF 读成文本或 base64 交给模型。此工具不保证任意客户端支持 MCP，也不能在客户端关闭时唤醒它。

## 状态和恢复

| 状态 | 含义与处理 |
| --- | --- |
| `prepared` | 已创建副本，还未请求上传；24 小时内可发送 |
| `sending` | 请求已开始或进程在发送期间退出；先查 QQ，不能自动重发 |
| `gateway-accepted` | 网关返回成功；不等于对方已经收到、下载或打开 |
| `unknown` | 网络、超时、响应异常或网关失败导致结果不确定；先查 QQ，不能自动重发 |
| `expired` | 准备超过 24 小时，未发送；由用户决定是否重新准备 |

同一记录再次调用发送不会重复发起已开始或已完成的上传。异常退出留下的锁不会自动删除。**这不是端到端“恰好一次”保证**：换 ID、新建副本、删除状态目录都可能造成重复。`unknown` 或 `sending` 不能通过重新 prepare 绕过，必须先由人核实收件 QQ。

自动清理在下一次准备文件时运行：未发送副本保留 24 小时，已受理/过期记录保留 7 天；有发送锁、`unknown`、`sending` 记录继续保留。总计最多 64 条、128MiB，每个文件最多 32MiB。不确定记录长期占用额度时应人工核实后清理；本工具不提供一键重置或自动补发。

## 文件和隐私边界

- 源文件必须位于配置的允许目录内；真实路径也须在范围内，链接不能指向范围外。
- 配置、常见凭据文件、框架私有状态目录等名称被拦截。这只是额外护栏，不能识别任意文件内的秘密；只应将用户明确同意发送的产物放进允许目录。
- 准备时复制并计算 SHA-256，发送前复核副本；准备后的收件人或网关变更会阻止上传。
- 本地配置、暂存文件和元数据可能含有私人信息，应保护 `FILE_SECRETARY_HOME`，不要提交 Git。网关及 QQ 平台会处理实际文件内容。
- MCP 结果含文件名、大小、散列和收件人，可能被使用它的 AI 客户端记录；不返回文件正文、本地源路径或访问令牌。不收集聊天历史或遥测。
- 这不是抵御同一系统账号下恶意进程的沙箱；目录与配置应仅供可信用户维护。

## 同类项目与定位

这是一个范围较窄的可复用工具，不宣称首创 QQ 文件发送、防重发或文件校验。

| 项目 | 已有能力 | 本工具的定位 |
| --- | --- | --- |
| [onebot-mcp](https://github.com/Frostbite-time/onebot-mcp) | HTTP MCP 包装多种 OneBot 动作；上传依赖后端能看到文件路径 | 专门面向本机固定收件人的文件任务，直接提供 stdio 与 CLI |
| [astral-im-bridge](https://github.com/oines/astral-im-bridge) | QQ/Telegram 与 Astral Code 双向桥接，提供文件工具和消息历史 | 仅做输出文件投递，不需要接收事件、聊天数据库或 Astral 会话 |
| [onebot-agent-bridge](https://github.com/Reshwell/onebot-agent-bridge) | CLI/MCP/HTTP、常驻队列、持久化 requestId 防重发和不确定状态处理 | 不需要额外接收守护进程；以准备副本、固定收件人、发送/查询为入口 |
| [SnowLuma MCP](https://github.com/SnowLuma/SnowLuma/blob/main/packages/mcp/README.md) | 通用动作查询/执行，支持有根目录限制、校验和配额的文件流上传 | 组合成限定用途的文件发送流程；不向 Agent 开放通用动作执行 |

比较依据为这些项目截至 2026-10-23 的公开文档，没有对全部项目做实机性能或可靠性排名。[设计说明](docs/DESIGN.md) 记录接口依据与取舍。

## 开发与维护

```powershell
npm ci --ignore-scripts
npm test
```

测试使用临时目录和模拟网关，不会发送真实 QQ 文件。维护者请先读 [AGENTS.md](AGENTS.md)、[变更记录](CHANGELOG.md) 和 [设计说明](docs/DESIGN.md)。MIT 许可；来源与第三方边界见 [NOTICE](NOTICE) 和 [LICENSE](LICENSE)。
