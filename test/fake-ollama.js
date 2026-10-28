import http from 'node:http';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const cache=process.env.OLLAMA_MODELS;mkdirSync(cache,{recursive:true});
const tags=join(cache,'fake-tags.json');let pulls=0,chats=0;
const models=()=>existsSync(tags)?JSON.parse(readFileSync(tags,'utf8')):[];
const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/version')return res.end(JSON.stringify({version:'0.40.2'}));
  if(req.url==='/api/tags')return res.end(JSON.stringify({models:models().map(name=>({name}))}));
  if(req.url==='/api/show')return res.end(JSON.stringify({details:{family:'qwen35'}}));
  if(req.url==='/stats')return res.end(JSON.stringify({pulls,chats,cuda:process.env.CUDA_VISIBLE_DEVICES,spread:process.env.OLLAMA_SCHED_SPREAD}));
  if(req.url==='/api/pull'){pulls++;writeFileSync(tags,JSON.stringify([...new Set([...models(),body.model])]));return res.end(JSON.stringify({status:'success'})+'\n');}
  if(req.url==='/api/generate')return res.end('{}');
  if(req.url==='/api/chat'){
    if(body.model===process.env.FAKE_OOM_MODEL){res.statusCode=500;return res.end('out of memory');}
    if(!body.messages.length)return res.end(JSON.stringify({done:true}));
    chats++;res.write(JSON.stringify({message:{content:'fake response'}})+'\n');
    setTimeout(()=>res.end(JSON.stringify({done:true,eval_count:3,prompt_eval_count:2})+'\n'),100);return;
  }res.statusCode=404;res.end('{}');
});
const url=new URL('http://'+process.env.OLLAMA_HOST);server.listen(Number(url.port),url.hostname);
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
