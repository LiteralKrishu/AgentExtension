const assert=require('node:assert/strict');
const {test}=require('node:test');
const {chunksFor,fuse,pack}=require('./semantic-chunks.cjs');

test('full-source semantic chunks retain late text, exact offsets, and explicit quotas',()=>{
 const text='x'.repeat(6100)+'\nfunction lateTarget() {}\n';
 const files=[{path:'src/a.js',text}];const chunks=chunksFor(files);
 assert.ok(chunks.some(chunk=>chunk.text.includes('lateTarget')));
 for(const chunk of chunks){assert.equal(chunk.text,text.slice(chunk.start,chunk.end));assert.ok(chunk.text.length<=2200);assert.match(chunk.contentHash,/^[a-f0-9]{64}$/);}
 assert.throws(()=>chunksFor(files,{maxChunks:1}),/quota/);
 assert.throws(()=>chunksFor(files,{size:100,overlap:100}),/bounds/);
 assert.deepEqual(chunksFor([{path:'empty.js',text:''}]),[]);
});

test('semantic fusion preserves exact candidates and packing includes metadata in its budget',()=>{
 assert.equal(fuse(['a','b'],['b','a'],['exact'],.5)[0],'exact');
 const files=[{path:'a',text:'fallback'},{path:'b',text:'fallback'}];
 const best=new Map([['a',{file:'a',start:100,text:'late excerpt'}]]);
 const result=pack(['a','b'],best,files,70);assert.ok(result.characters<=70);assert.deepEqual(result.selected,['a']);
});
