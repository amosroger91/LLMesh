export function recordInference(metric,{firstTokenMs,tokens,durationMs,buffered=false}){
  const blend=(old,value)=>Number.isFinite(old)?old*0.7+value*0.3:value;
  if(Number.isFinite(firstTokenMs)&&firstTokenMs>=0)metric.firstTokenMs=blend(metric.firstTokenMs,firstTokenMs);
  if(Number.isSafeInteger(tokens)&&tokens>0&&Number.isFinite(durationMs)&&durationMs>=firstTokenMs){
    const elapsed=Math.max(50,durationMs-(buffered?0:firstTokenMs));
    metric.generatedTokens=(metric.generatedTokens??0)+tokens;metric.generationMs=(metric.generationMs??0)+elapsed;
    metric.averageTokensPerSecond=metric.generatedTokens/(metric.generationMs/1000);
    metric.tokensPerSecond=blend(metric.tokensPerSecond,tokens/Math.max(0.05,(durationMs-(buffered?0:firstTokenMs))/1000));
    metric.samples=(metric.samples??0)+1;
  }
  return metric;
}

// Local startup probes never enter billing or mesh traffic counters.
export async function benchmarkInference(stream,metric={},clock=()=>performance.now()){
  const started=clock();let firstAt,completed=false;
  for await(const part of stream){
    if(part.type==='delta'&&part.text&&firstAt==null)firstAt=clock();
    if(part.type==='done'&&firstAt!=null&&part.tokens>0){recordInference(metric,{firstTokenMs:firstAt-started,tokens:part.tokens,durationMs:clock()-started});completed=true;}
  }
  if(!completed)throw new Error('Startup benchmark produced no metered text');
  return metric;
}
export const BENCHMARK_MESSAGES=[{role:'user',content:'Count from one to thirty, writing each number as a word separated by a comma.'}];
export function publicMetrics(value={}){
  const result={};for(const key of ['averageTokensPerSecond','tokensPerSecond','firstTokenMs','samples'])if(Number.isFinite(value[key])&&value[key]>=0&&value[key]<=10000000)result[key]=value[key];return result;
}
