import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { hookHost } from './helpers/hookHost.mjs'
const code = (await build({ entryPoints: ['frontend/src/hooks/useProjectLocation.js'], absWorkingDir: new URL('../../',import.meta.url).pathname,
  bundle:true,write:false,platform:'node',format:'cjs',packages:'external',plugins:[{name:'owned-api',setup(b){
    b.onResolve({filter:/lib\/api\.js$/},()=>({path:'api',namespace:'qa'}));
    b.onLoad({filter:/.*/,namespace:'qa'},()=>({contents:'export const listWorkspaces = () => __remote();'}));
  }}] })).outputFiles[0].text
const a = 'aaca4743-6f42-45a7-9dc5-1601555a9911', b = 'aaca4743-6f42-45a7-9dc5-1601555a9922'
function options(rest={}) {
  return { user:'alice', route:{view:'generate',projectId:b,step:'adjust',serial:1,external:true},
    editor:{ready:true,workspace:{id:a,user_id:'alice',view_state:{creation_step:'photos'}},listProjects:async()=>[],deletedProjectIds:async()=>[]},
    beforeRestore(){},isBusy:()=>false,currentStep:()=> 'photos',onLocationChange(){},loadProject:async p=>p,...rest }
}
test('busy project navigation preserves current identity and does not perform an ownership or loading request',async()=>{
  const calls=[],h=hookHost(code,{__remote:()=>{throw new Error('unexpected API')}})
  h.render(options({isBusy:()=>true,onLocationChange:(...args)=>calls.push(args),loadProject:()=>{throw new Error('unexpected load')}}))
  assert.equal(h.value.pending,false);assert.match(h.value.error.message,/尚未结束/)
  assert.deepEqual(calls,[[a,'photos',{replace:true}]]);h.unmount()
})
test('mounting an already-selected internal location never waits for an external restore',()=>{
  const h=hookHost(code,{__remote:()=>{throw new Error('unexpected API')}})
  const initial=options()
  h.render({...initial,route:{...initial.route,external:false}})
  assert.equal(h.value.pending,false);h.unmount()
})
test('a delayed old project lookup cannot replace a newer navigation target',async()=>{
  let release,loads=0
  const h=hookHost(code,{__remote:()=>new Promise(resolve=>{release=resolve})})
  const initial=options({loadProject:async()=>{loads++;return{id:b}}})
  h.render(initial);await h.settle();assert.equal(h.value.pending,true)
  h.render({...initial,route:{view:'generate',projectId:a,step:'save',serial:2,external:true}})
  release([{id:b}]);await h.settle()
  assert.equal(loads,0);assert.equal(h.value.selection.workspaceId,a);assert.equal(h.value.selection.step,'save');h.unmount()
})
for (const external of [false, true]) test(`leaving a pending request by ${external ? 'browser history' : 'page action'} clears loading and ignores the late result`,async()=>{
  let release,loads=0
  const h=hookHost(code,{__remote:()=>new Promise(resolve=>{release=resolve})})
  const initial=options({loadProject:async()=>{loads++;return{id:b}}})
  h.render(initial);await h.settle();assert.equal(h.value.pending,true)
  h.render({...initial,route:{view:'library',serial:2,external}})
  assert.equal(h.value.pending,false)
  release([{id:b}]);await h.settle();assert.equal(loads,0);h.unmount()
})
test('failed ownership lookup stays explicitly retryable and success restores the same target once',async()=>{
  let attempt=0,loads=0
  const h=hookHost(code,{__remote:async()=>{if(++attempt===1)throw new Error('Failed to fetch');return[{id:b}]}})
  h.render(options({loadProject:async p=>{loads++;return p}}));await h.settle()
  assert.equal(h.value.error.retry,true);assert.equal(h.value.pending,false);assert.equal(loads,0)
  h.value.retry();h.render();await h.settle()
  assert.equal(h.value.error,null);assert.equal(h.value.selection.workspaceId,b);assert.equal(loads,1)
  h.render();await h.settle();assert.equal(loads,1);h.unmount()
})
test('choosing a different project supersedes a failed address request instead of leaving the old URL active',async()=>{
  const calls=[]
  const h=hookHost(code,{__remote:async()=>{throw new Error('Failed to fetch')}})
  const initial=options({onLocationChange:(...args)=>calls.push(args)})
  h.render(initial);await h.settle();assert.equal(h.value.error.retry,true)
  h.render({...initial,editor:{...initial.editor,workspace:{id:b,user_id:'alice'}}})
  assert.equal(h.value.error,null);assert.equal(h.value.pending,false)
  assert.deepEqual(calls,[[b,'photos']]);h.unmount()
})
