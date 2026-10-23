# Agent 接入与使用流程

仅由可信本机用户的工作 Agent 使用，用户明确指定文件并要求发送才可调用。不要给QQ群聊的普通成员开放本机文件权限。

1. 确定唯一指定文件。没有唯一文件时询问用户，不能扫描或打包私人资料。
2. 首次调用 `file_secretary_help`，再 `prepare_file({file:绝对路径})`。
3. 记住返回的 `deliveryId`、文件名和大小；按同一请求调用 `send_file({deliveryId})`。
4. `gateway-accepted` 只报告“网关已受理”，收件方确认后才报告实际收到。
5. `unknown`、`sending`、`busy` 时查 `delivery_status` 和 QQ，不得自动重发或新建 ID。

本工具直接交给本机网关文件路径，不需要模型读取正文，不使用模型 API。配置接入前，先按 README 用 CLI 检查准备流程。

## Codex

在 Codex 的用户配置文件中合并以下独立条目，保留其他设置。以 [Codex MCP 文档](https://developers.openai.com/codex/mcp/) 为配置依据。

```toml
[mcp_servers.snowluma_file_sender]
command = "node"
args = ["D:/tools/snowluma-qq-file-sender/src/mcp.js"]
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 150

[mcp_servers.snowluma_file_sender.env]
FILE_SECRETARY_HOME = "D:/file-sender-home"
ONEBOT_ACCESS_TOKEN = "YOUR_LOCAL_GATEWAY_TOKEN"
```

路径和令牌需替换；保护真实配置，不提交 Git。修改后按客户端方式重载 MCP，先检查是否出现四个工具。当前会话尚未加载时用 CLI 兜底，不应反复重启 QQ。

## DeepSeek Harness 或其他 stdio 客户端

在客户端的 MCP 服务管理中新增本地 stdio 服务：命令 `node`；参数为本仓库 `src/mcp.js` 的绝对路径；环境变量为 `FILE_SECRETARY_HOME` 与 `ONEBOT_ACCESS_TOKEN`。需要使用 Node.js 24+。

不同 Harness 版本的插件/配置格式可能不同，请使用该版本的 MCP 配置界面或官方说明。不要直接覆盖整个配置文件。本仓库不安装 Harness、不注入聊天预设，未声称验证所有版本的配置导入。

## CLI 兜底

先设置 README 中两个环境变量，再运行 `node src/cli.js --file <绝对路径>`。会先打印 `prepared` 的记录 ID，再打印发送结果。CLI 返回码：0 表示准备完成或网关受理，2 表示过期/不确定/忙等状态，1 表示参数或操作错误。返回码 0 不能证明收件人已打开附件。

中断后用 `--status <deliveryId>` 查询；不要重新执行 `--file` 碰运气。收件人和网关地址变更会使旧准备记录拒绝发送。凭据轮换不改变既定收件人；令牌仅从进程环境读取。
