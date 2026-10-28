export function recordInference(metric,{firstTokenMs,tokens,durationMs,buffered=false}){
  const blend=(old,value)=>Number.isFinite(old)?old*0.7+value*0.3:value;
  if(Number.isFinite(firstTokenMs)&&firstTokenMs>=0)metric.firstTokenMs=blend(metric.firstTokenMs,firstTokenMs);
  if(Number.isSafeInteger(tokens)&&tokens>0&&Number.isFinite(durationMs)&&durationMs>=firstTokenMs){
    metric.tokensPerSecond=blend(metric.tokensPerSecond,tokens/Math.max(0.05,(durationMs-(buffered?0:firstTokenMs))/1000));
    metric.samples=(metric.samples??0)+1;
  }
  return metric;
}
