# 设计与验证边界

## 为什么独立成小工具

将“把产物发给我”限制为固定本地配置的 QQ 收件人，比给 Agent 一整套 OneBot 管理接口更容易接入和审查。MCP 仍只提供四个工具；可独立运行，不调用模型 API。0.2.0 的独立 QQ 监听服务默认关闭，严格校验私聊事件的会话、发信人和消息编号；群聊不能触发文件操作。详见 [查找流程](QQ_FILE_SEARCH.md)。

`prepare` 读取允许目录中的指定普通文件，创建本地副本和 SHA-256；发送时复核副本与准备时的收件人/网关。源文件后续变化不会悄悄改变上传内容。副本与元数据位于用户指定的运行目录，不使用系统临时目录存放业务文件。

`send` 先取得独占锁并把状态写为 `sending`，再调用 HTTP。网络失败无法证明远端没有处理，故保存 `unknown`。所有非成功响应同样保守处理；不依赖各后端并不统一的错误码去自动补发。锁及状态跨进程保留；异常中断需人工核实，不自动清锁。

只在同一 ID 上抑制重复请求，不能承诺整个 QQ 网络的恰好一次；状态损坏、磁盘故障、换 ID 或人为改动都会超出此边界。原子替换用于避免部分 JSON，不承诺断电后的完整持久性。具备同一系统账号写权限的进程可改配置和副本，超出本工具威胁模型。

## 接口依据与参考

- [NapCat UploadPrivateFile 实现](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/go-cqhttp/UploadPrivateFile.ts)：确认扩展动作从后端可见的本机路径构建文件并发送。
- [OneBot v11 API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)：该文件上传动作属于后端扩展，不能声称所有 OneBot 实现兼容。
- [SnowLuma](https://github.com/SnowLuma/SnowLuma)：本地原型的实际网关；本仓库使用 HTTP 和可选 OneBot WebSocket 协议，不包含其源码、SDK、原生组件或二进制。
- [OneBot 正向 WebSocket](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md) 与 [鉴权](https://github.com/botuniverse/onebot-11/blob/master/communication/authorization.md)：监听 `/event` 或 `/`，仅本机 IP，令牌从环境变量放入查询参数，不打印连接 URL。
- 同类项目见 README 比较表。它们提供更广能力，值得在需要聊天收发、多平台或远程部署时优先评估。

除文件秘书原型按 MIT 提取并保留署名外，没有复制其他比较项目的实现。

## 测试与真实验收

原型在 Windows、官方 SnowLuma 2.1.1 上完成过真实 PDF 私聊投递，收件方确认可打开。公开版本保持同类上传请求，并增加可配置收件人/根目录、准备后配置变更拒绝发送和保守错误处理。公开测试使用模拟网关，不能替代你的账号、网络与后端版本的实际验收。

0.2.0 自动化测试同时覆盖模拟 WebSocket 私聊请求→候选→上传→文本回复、身份/配置撤销、跨进程锁、重放、防止不确定结果重新准备，以及固定 QQ 域名下载的 DNS/IP/TLS/重定向/长度/时限边界。私有原型做过真实群文件下载与校验；完整的新版本人 QQ 发起→收件流程仍待实机验收，不能把模拟通过写成 QQ 已确认收到。

不要为了测试自动重复发送用户文件。首次用自己的非敏感样例，核实已准备 ID，发送一次后由收件方确认。超时先检查 QQ，不要换 ID 重发。
