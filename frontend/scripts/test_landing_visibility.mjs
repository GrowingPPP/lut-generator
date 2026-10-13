import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { hookHost } from './helpers/hookHost.mjs'
const code=(await build({entryPoints:['frontend/src/hooks/useNearViewport.js'],absWorkingDir:new URL('../../',import.meta.url).pathname,bundle:true,write:false,platform:'node',format:'cjs',packages:'external'})).outputFiles[0].text
// Observe real hook transitions, including lifecycle cleanup; no image/network
// work should be enabled before the below-fold section approaches the viewport.
test('below-fold readiness is one-way and observation stops after entry or unmount',()=>{
  let callback,observed,disconnections=0
  const original=globalThis.IntersectionObserver
  globalThis.IntersectionObserver=class {constructor(fn){callback=fn}observe(node){observed=node}disconnect(){disconnections++}}
  try {
    const ref={current:{}},h=hookHost(code)
    assert.equal(h.render(ref),false);assert.equal(observed,ref.current)
    callback([{isIntersecting:false}]);assert.equal(h.render(),false)
    callback([{isIntersecting:true}]);assert.equal(h.render(),true)
    assert.ok(disconnections>0);h.unmount()
    const second=hookHost(code);second.render(ref);const before=disconnections;second.unmount();assert.equal(disconnections,before+1)
  } finally {globalThis.IntersectionObserver=original}
})
