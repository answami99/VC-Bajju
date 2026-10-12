const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
test('opening a loaded review needs no network request',async()=>{
  let opened;
  const review={id:'review',revision:'saved'};
  const state={reviews:[review]};
  const ctx=vm.createContext({busy:false,state,adoptReview:(s,r)=>opened={s,r},rpc:()=>{throw Error('Unexpected request');}});
  vm.runInContext(html.split('\n').find(line=>line.startsWith('async function openReview(')),ctx);
  await ctx.openReview('review');
  assert.equal(opened.s,state);
  assert.equal(opened.r,review);
  ctx.busy=true;opened=null;
  await ctx.openReview('review');assert.equal(opened,null);
});
test('a background check disables only its own check control',()=>{
  const ctx=vm.createContext({state:{background:{running:true,queued:[]}},busy:false,icon:()=>''});
  vm.runInContext(html.slice(html.indexOf('function checkBtn(){'),html.indexOf('function empty(')),ctx);
  assert.match(ctx.checkBtn(),/Checking in background/);
  assert.match(ctx.checkBtn(),/disabled/);
  assert.equal(ctx.busy,false);
  ctx.state.background={running:false,queued:['12-10-2026']};
  assert.match(ctx.checkBtn(),/Check queued/);
  ctx.state.background={running:false,queued:[]};
  assert.doesNotMatch(ctx.checkBtn(),/disabled/);
});
test('queue acknowledgement does not claim a completed schedule check',async()=>{
  const messages=[];
  const ctx=vm.createContext({busy:false,state:null,review:null,handoff:null,selection:new Set(),
    document:{querySelectorAll:()=>[]},rpc:async()=>({checkQueued:true}),
    render:()=>{},toast:s=>messages.push(s),error:e=>{throw e;}
  });
  vm.runInContext(html.slice(html.indexOf('async function perform('),html.indexOf("\ndocument.addEventListener('click',e=>{const el=e.target.closest('button,a')")),ctx);
  await ctx.perform('check',{date:'12-10-2026'});
  assert.equal(messages.length,1);
  assert.match(messages[0],/queued/);
  assert.doesNotMatch(messages[0],/up to date|completed/);
  assert.equal(ctx.busy,false);
});

test('adding officers opens a review without an approval or send action',async()=>{
  const calls=[],review={id:'extra-review',sentIds:['sent-officer'],selected:[]};
  let opened;
  const ctx=vm.createContext({view:'desk',state:null,perform:async(action,input,done)=>{calls.push({action,input});done({reviewId:review.id,state:{reviews:[review]}});},adoptReview:(s,r)=>opened=r,toast:()=>{},render:()=>{}});
  vm.runInContext(html.split('\n').find(line=>line.startsWith('async function addReviewOfficers(')),ctx);
  await ctx.addReviewOfficers('meeting','revision');
  assert.equal(calls.length,1);assert.equal(calls[0].action,'reopen_review');
  assert.equal(calls[0].input.meeting,'meeting');assert.equal(calls[0].input.revision,'revision');
  assert.equal(opened,review);assert.equal(ctx.view,'reviews');
});
test('previously confirmed recipients cannot be reselected when adopting a review',()=>{
  const ctx=vm.createContext({selection:new Set(),state:null,review:null,handoff:null,noticeDepartment:false,noticeDepartmentName:'',render:()=>{},renderReview:()=>{}});
  const source=html.slice(html.indexOf('function adoptReview('),html.indexOf('async function addReviewOfficers('));
  vm.runInContext(source,ctx);
  ctx.adoptReview({contacts:[{id:'sent',active:true},{id:'new',active:true}]},{selected:['sent','new'],sentIds:['sent'],department:''});
  assert.deepEqual(Array.from(ctx.selection),['new']);
});
