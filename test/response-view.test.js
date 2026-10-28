import test from 'node:test';import assert from 'node:assert/strict';
import {splitThinking} from '../src/ui/response-view.js';
test('think tags split across stream chunks stay out of the answer and empty reasoning is empty',()=>{
 assert.deepEqual(splitThinking('<thi'),[]);
 assert.deepEqual(splitThinking('<think>reasoning</thi'),[{thought:true,text:'reasoning'}]);
 const parts=splitThinking('<think>\n\n</think>\nHello!',true);
 assert.equal(parts.filter(part=>part.thought).every(part=>!part.text.trim()),true);
 assert.equal(parts.filter(part=>!part.thought).map(part=>part.text).join('').trim(),'Hello!');
 assert.deepEqual(splitThinking('<think>reasoning</think>Answer',true),[{thought:true,text:'reasoning'},{thought:false,text:'Answer'}]);
 assert.deepEqual(splitThinking('<think>unfinished reasoning',true),[{thought:true,text:'unfinished reasoning'}]);
});
