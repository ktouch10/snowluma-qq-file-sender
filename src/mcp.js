import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {SecretaryFiles} from './secretary-files.js';
import {WORKFLOW, safeError} from './workflow.js';

export function registerTools(server, service) {
  const wrap = fn => async args => {
    try { return {content:[{type:'text',text:JSON.stringify(await fn(args))}]}; }
    catch(error) { return {isError:true,content:[{type:'text',text:safeError(error)}]}; }
  };
  const read = {readOnlyHint:true,destructiveHint:false,openWorldHint:false};
  server.registerTool('file_secretary_help', {
    description:'本机文件秘书流程。用户要求把文件发给自己时先读此工具。', inputSchema:{}, annotations:read
  }, wrap(()=>({workflow:WORKFLOW})));
  server.registerTool('prepare_file', {
    description:'准备用户指定的文件副本，不发送。返回 deliveryId；收件人由本地配置固定。',
    inputSchema:{file:z.string().min(1).max(4096)},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}
  }, wrap(({file})=>service.prepare(file)));
  server.registerTool('send_file', {
    description:'按用户指令发送已准备文件，只传 deliveryId。unknown/sending/busy 禁止自动重发。',
    inputSchema:{deliveryId:z.string().uuid()},
    annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:true}
  }, wrap(({deliveryId})=>service.send(deliveryId)));
  server.registerTool('delivery_status', {
    description:'查询同一 deliveryId 的本地状态，不发文件；不代表收件方已下载。',
    inputSchema:{deliveryId:z.string().uuid()},annotations:read
  }, wrap(({deliveryId})=>service.status(deliveryId)));
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const service = new SecretaryFiles({root:process.env.FILE_SECRETARY_HOME});
    const server = new McpServer({name:'snowluma-qq-file-sender',version:'0.2.0'});
    registerTools(server,service);
    await server.connect(new StdioServerTransport());
  } catch(error) { console.error(safeError(error)); process.exitCode=1; }
}
