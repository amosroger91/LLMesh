export function splitThinking(text,final=false){
  const parts=[];let thought=false,rest=text;
  while(rest){const tag=thought?'</think>':'<think>',at=rest.indexOf(tag);
    if(at>=0){if(at)parts.push({thought,text:rest.slice(0,at)});rest=rest.slice(at+tag.length);thought=!thought;continue;}
    let hold=0;if(!final)for(let size=1;size<tag.length;size++)if(rest.endsWith(tag.slice(0,size)))hold=size;
    const visible=rest.slice(0,rest.length-hold);if(visible)parts.push({thought,text:visible});break;
  }
  return parts;
}
export function responseView(target){
  const root=document.createElement('div');root.className='response-content';target.append(root);let raw='';
  const render=final=>{const opened=[...root.querySelectorAll('details')].map(item=>item.open);root.replaceChildren();let index=0;
    for(const part of splitThinking(raw,final)){if(part.thought){if(!part.text.trim())continue;const details=document.createElement('details'),summary=document.createElement('summary'),content=document.createElement('div');summary.textContent='Model reasoning';content.textContent=part.text.trim();details.open=opened[index++]??false;details.append(summary,content);root.append(details);}
      else{const answer=document.createElement('div');answer.textContent=part.text;root.append(answer);}}
    const scroller=target.closest('.chat-log')??target;scroller.scrollTop=scroller.scrollHeight;
    if(target.closest('#companion-history'))root.scrollIntoView({block:'end',behavior:'instant'});
  };
  return {appendData(text){raw+=text;render(false);},finish(){render(true);},get textContent(){return raw;}};
}
