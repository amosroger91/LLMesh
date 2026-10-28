import {spawn} from 'node:child_process';
for(let attempt=1;attempt<=3;attempt++){
 const status=await new Promise(resolve=>{const child=spawn(process.execPath,['scripts/model-vault.js','upload',process.argv[2]],{stdio:'inherit',env:process.env,windowsHide:true});child.once('error',()=>resolve(1));child.once('exit',code=>resolve(code??1));});
 if(status===0)process.exit(0);if(attempt===3)process.exit(status);console.log('Retrying incomplete verified archive transfer, attempt '+(attempt+1));await new Promise(resolve=>setTimeout(resolve,5000));
}
