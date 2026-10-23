#!/usr/bin/env node
import {SecretaryFiles} from './secretary-files.js';
import {WORKFLOW,safeError} from './workflow.js';
const args=process.argv.slice(2);
if(!args.length || args[0]==='--help') {
  console.log(WORKFLOW+'\nnode src/cli.js --file <absolute-path> [--prepare-only]\nnode src/cli.js --send-id <deliveryId>\nnode src/cli.js --status <deliveryId>');
} else {
  try {
    const files=new SecretaryFiles({root:process.env.FILE_SECRETARY_HOME});
    let result;
    if(args.length===2 && args[0]==='--status') result=files.status(args[1]);
    else if(args.length===2 && args[0]==='--send-id') result=await files.send(args[1]);
    else if(args[0]==='--file' && args[1] && (args.length===2 || (args.length===3 && args[2]==='--prepare-only'))) {
      result=files.prepare(args[1]);
      console.log(JSON.stringify(result)); // Print the durable ID BEFORE the network request.
      if(args[2]!=='--prepare-only') result=await files.send(result.deliveryId);
      else result=null;
    } else { console.error('Use --help for CLI arguments.'); process.exitCode=1; }
    if(result) {
      console.log(JSON.stringify(result));
      if(!['prepared','gateway-accepted'].includes(result.status) || result.busy) process.exitCode=2;
    }
  } catch(error) { console.error(safeError(error)); process.exitCode=1; }
}
