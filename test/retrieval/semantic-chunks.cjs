// A second, evaluation-only configuration. The normal retrieval path never loads it.
const fs=require('node:fs/promises');
const path=require('node:path');
const {performance}=require('node:perf_hooks');
const {EmbeddingProvider,VectorCache,similarity}=require('../../src/embedding-provider');
const {rank}=require('../../src/context');
const {digest}=require('../../src/permissions');
const {snapshot}=require('./run.cjs');
const labels=require('./queries.json');

function chunksFor(files,{size=2200,overlap=200,maxChunks=1400}={}){
 if(!Number.isInteger(size)||size<100||size>5000||!Number.isInteger(overlap)||overlap<0||overlap>=size)throw new Error('Invalid chunk bounds.');
 const chunks=[];
 for(const file of files){
  for(let start=0;start<file.text.length;start+=size-overlap){
   if(chunks.length>=maxChunks)throw new Error('Semantic chunk quota reached.');
   const end=Math.min(start+size,file.text.length);
   chunks.push({file:file.path,start,end,text:file.text.slice(start,end),contentHash:digest(file.text)});
   if(end===file.text.length)break;
  }
 }
 return chunks;
}

function fuse(lexical,semantic,pinned,weight){
 const scores=new Map();
 for(const [list,w] of [[lexical,1-weight],[semantic,weight]])for(const [i,file]of list.entries())scores.set(file,(scores.get(file)??0)+w/(61+i));
 return [...new Set([...pinned,...[...scores].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([file])=>file)])];
}

function pack(hits,bestChunks,files,budget=12000){
 const selected=[];let used=0;
 for(const file of hits.slice(0,10)){
  const chunk=bestChunks.get(file)??{file,start:0,text:files.find(item=>item.path===file).text.slice(0,2200)};
  const size=JSON.stringify({file,startOffset:chunk.start,text:chunk.text}).length+1;
  if(used+size>budget)continue;
  used+=size;selected.push(file);
 }
 return {selected,characters:used};
}

async function main(){
 const provider=new EmbeddingProvider({endpoint:process.env.AGENTEXTENSION_EMBEDDING_URL,model:process.env.AGENTEXTENSION_EMBEDDING_MODEL});
 const {files,revision}=await snapshot();const chunks=chunksFor(files);
 const scope=digest([revision,files.map(({path,text})=>[path,digest(text)])]);
 const directory=process.env.AGENTEXTENSION_TEST_RESULTS_DIR??path.join(__dirname,'../../test-results/semantic-chunks');
 await fs.mkdir(directory,{recursive:true});
 const texts=chunks.map(chunk=>'search_document: '+chunk.file+'\n'+chunk.text);
 const started=performance.now();const [probe]=await provider.embed([texts[0]]);
 const namespace={schema:2,endpoint:provider.endpoint,model:provider.model,dimension:provider.dimension,scope,chunkSize:2200,overlap:200};
 const cache=new VectorCache(path.join(directory,'chunk-vectors.json'),namespace);
 const keys=texts.map(text=>provider.key(text,scope));const vectors=await cache.load(keys);vectors.set(keys[0],probe);
 for(let i=0;i<texts.length;i+=8){
  const missing=texts.slice(i,i+8).map((text,n)=>({text,key:keys[i+n]})).filter(item=>!vectors.has(item.key));
  if(!missing.length)continue;
  const batch=await provider.embed(missing.map(item=>item.text));missing.forEach((item,n)=>vectors.set(item.key,batch[n]));
 }
 let cacheBytes=null,cacheError=null;
 try{await cache.replace(vectors);cacheBytes=(await fs.stat(cache.file)).size;}catch(error){cacheError=error.message;}
 const preparationMs=performance.now()-started;
 const queryVectors=[];
 for(let i=0;i<labels.queries.length;i+=8)queryVectors.push(...await provider.embed(labels.queries.slice(i,i+8).map(query=>'search_query: '+query.query)));
 const rows=labels.queries.map((query,q)=>{
  const best=new Map();
  for(let i=0;i<chunks.length;i++){
   const chunk=chunks[i],score=similarity(queryVectors[q],vectors.get(keys[i]));
   if(!best.has(chunk.file)||score>best.get(chunk.file).score)best.set(chunk.file,{...chunk,score});
  }
  const semantic=[...best.values()].sort((a,b)=>b.score-a.score||a.file.localeCompare(b.file)).map(item=>item.file);
  const ranked=rank(files,query.query);const lexical=[...new Set(ranked.map(item=>item.file))];
  const pinned=[...new Set(ranked.filter(item=>item.priority>0).map(item=>item.file))];
  const candidates={lexical,semantic,...Object.fromEntries([.25,.5,.75].map(weight=>['hybrid-'+weight,fuse(lexical,semantic,pinned,weight)]))};
  const expected=[...new Set(Object.values(query.expected).flat())];
  const results=Object.fromEntries(Object.entries(candidates).map(([name,list])=>{
   const hits=list.slice(0,10),packed=pack(list,best,files);
   return [name,{hits,recall:expected.filter(file=>hits.includes(file)).length/expected.length,
    exact:query.kind==='identifier'?query.expected.implementation.some(file=>hits.includes(file)):null,
    packedFiles:packed.selected,packedCharacters:packed.characters,
    packedCoverage:Object.fromEntries(Object.entries(query.expected).map(([kind,paths])=>[kind,paths.some(file=>packed.selected.includes(file))]))}];
  }));
  return {id:query.id,split:query.split,kind:query.kind,results};
 });
 const variants=Object.keys(rows[0].results);
 const average=(name,split)=>{const selected=rows.filter(row=>!split||row.split===split);return selected.reduce((sum,row)=>sum+row.results[name].recall,0)/selected.length;};
 // Select using development labels only. Held-out results below are an exposed-set comparison.
 const selected=[...variants].sort((a,b)=>average(b,'development')-average(a,'development')||variants.indexOf(a)-variants.indexOf(b))[0];
 const report={version:2,recordedAt:new Date().toISOString(),corpus:labels.version,sourceRevision:revision,inputDigest:digest(files),namespace,
  files:files.length,chunks:chunks.length,chunkSize:2200,overlap:200,maxChunks:1400,contextBudget:12000,
  preparationMs,requests:provider.requests,embeddedCharacters:provider.characters,cacheBytes,cacheError,memory:process.memoryUsage(),apiSpend:0,
  selectedOnDevelopment:selected,results:variants.map(name=>({name,developmentRecall:average(name,'development'),heldOutRecall:average(name,'held-out'),recallAt10:average(name),
   exactFound:rows.filter(row=>row.kind==='identifier'&&row.results[name].exact).length})),
  enabledByDefault:false,decision:'Research only. Completion non-regression and a new independent held-out evaluation remain required.',
  limitation:'The original 40-query held-out set is exposed. Chunk candidates use full pinned source, unlike the earlier leading-excerpt configuration.',rows};
 await fs.writeFile(path.join(directory,'semantic-chunks.json'),JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({...report,rows:undefined},null,2));
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={chunksFor,fuse,pack};
