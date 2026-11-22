const assert=require('node:assert/strict');
const {test}=require('node:test');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const {openBridge}=require('../src/bridge');
const {Draft}=require('../src/draft');
const {PermissionBroker}=require('../src/permissions');

async function fixture(t,base,usage,selection,file='a.txt'){
 const controller=new AbortController();const permissions=new PermissionBroker({workspace:'/fixture',signal:controller.signal});
 permissions.allowScope('workspace.read');permissions.allowScope('draft.edit');
 let source=base;const read=async()=>source;const draft=new Draft(read,selection);
 const bridge=await openBridge({signal:controller.signal,permissions,draft,workspace:{read},usage});
 const client=new Client({name:'line-recovery',version:'1'});
 t.after(async()=>{await client.close();bridge.close();});
 await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
 const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});let value=result.content[0].text;try{value=JSON.parse(value);}catch{}return {result,value};};
 const initial=(await call('read_file',{file})).value;
 return {draft,read,receipt:initial.receipt,initial,call,change:text=>{source=text;}};
}

test('line edits normalize copied line endings and preserve surrounding CRLF source',async t=>{
 const f=await fixture(t,'prefix\r\nanchor\r\nsuffix');
 const {result,value}=await f.call('propose_lines',{receipt:f.receipt,anchor_line:'anchor\r\n',delete_count:1,new_text:'changed'});
 assert.equal(result.isError,undefined);assert.equal(value.format_notes.length,2);
 assert.equal(value.preview[0].text,'prefix\r\nchanged\r\nsuffix');assert.match(value.note,/Preview data only/);
 assert.equal(f.draft.current('a.txt',await f.read()),'prefix\r\nchanged\r\nsuffix');
 const stale=await f.call('propose_lines',{receipt:f.receipt,start_line:2,delete_count:1,new_text:'wrong\n'});
 assert.equal(stale.result.isError,true);
});

test('multiline anchors get a repair hint and changed source still rejects old receipts',async t=>{
 const f=await fixture(t,'prefix\nanchor\nsuffix');
 const multiline=await f.call('propose_lines',{receipt:f.receipt,anchor_line:'prefix\nanchor',delete_count:1,new_text:'changed\n'});
 assert.equal(multiline.result.isError,true);assert.match(multiline.value,/propose_write/);assert.equal(f.draft.files.size,0);
 f.change('external\nanchor\nsuffix');
 const stale=await f.call('propose_lines',{receipt:f.receipt,anchor_line:'anchor',delete_count:1,new_text:'changed'});
 assert.equal(stale.result.isError,true);assert.equal(f.draft.files.size,0);
});

test('a replacement at end of file keeps its intentional missing final newline',async t=>{
 const f=await fixture(t,'prefix\nanchor');
 const {result,value}=await f.call('propose_lines',{receipt:f.receipt,anchor_line:'anchor',delete_count:1,new_text:'changed'});
 assert.equal(result.isError,undefined);assert.equal(value.format_notes,undefined);
 assert.equal(f.draft.current('a.txt',await f.read()),'prefix\nchanged');
});

test('an ambiguous anchor can recover with a receipt-bound line number',async t=>{
 const f=await fixture(t,'same\nsame\nsuffix');
 const ambiguous=await f.call('propose_lines',{receipt:f.receipt,anchor_line:'same',delete_count:1,new_text:'changed\n'});
 assert.equal(ambiguous.result.isError,true);assert.match(ambiguous.value,/start_line between 1 and 3/);assert.equal(f.draft.files.size,0);
 const corrected=await f.call('propose_lines',{receipt:f.receipt,start_line:2,delete_count:1,new_text:'changed\n'});
 assert.equal(corrected.result.isError,undefined);assert.equal(f.draft.current('a.txt',await f.read()),'same\nchanged\nsuffix');
});

test('the editor returns a bounded host budget notice with successful tool evidence',async t=>{
 const {RunUsage}=require('../src/usage');const usage=new RunUsage({maxTokens:1000});
 usage.model({inputTokens:500,outputTokens:0});const f=await fixture(t,'anchor\n',usage);
 assert.equal(f.initial.text,'anchor\n');assert.equal(f.initial.run_budget.remainingTokens,500);
 const repeated=await f.call('read_file',{file:'a.txt'});assert.equal(repeated.value.run_budget,undefined);
 assert.equal(f.draft.files.size,0);
});

test('edit previews use current draft offsets after earlier insertions and stay bounded',async t=>{
 const base=Array.from({length:80},(_,i)=>`line-${i+1}\n`).join('');const f=await fixture(t,base);
 await f.call('propose_write',{file:'a.txt',old_text:'line-2\n',new_text:'new-a\nnew-b\nnew-c\n'});
 const result=await f.call('propose_write',{file:'a.txt',old_text:'line-70\n',new_text:'changed-seventy\n'});
 const current=f.draft.current('a.txt',base).split(/(?<=\n)/);
 assert.equal(result.value.preview.length,2);assert.ok(result.value.preview.some(p=>p.text.includes('changed-seventy')));
 for(const p of result.value.preview){assert.equal(p.text,current.slice(p.start_line-1,p.end_line).join(''));assert.ok(p.text.length<=1200);}
 const large=await f.call('propose_write',{file:'a.txt',old_text:'line-40\n',new_text:'added\n'.repeat(100)});
 assert.ok(large.value.preview.length<=3);assert.ok(large.value.preview.every(p=>p.text.length<=1200));
 assert.ok(large.value.preview.some(p=>p.truncated));
});

test('inline edit previews contain only the original selection and confer no line receipt',async t=>{
 const base='outside-before\nallowed\noutside-after\n';const start=base.indexOf('allowed');const end=start+'allowed'.length;
 const f=await fixture(t,base,undefined,{file:'a.txt',base,start,end});
 const {value}=await f.call('propose_write',{file:'a.txt',old_text:'allowed',new_text:'ALLOWED'});
 assert.equal(value.preview[0].text,'ALLOWED');assert.match(value.preview_scope,/relative to that selection/);
 assert.ok(!JSON.stringify(value).includes('outside'));assert.equal(value.receipt,undefined);
});

test('literal line arrays preserve indentation, backslashes, and CRLF source endings',async t=>{
 const base='exports.pattern = "old";\r\nexports.value = 1;\r\n';const f=await fixture(t,base);
 const lines=['exports.pattern = "\\\\n";','exports.value = 2;'];
 const {result,value}=await f.call('propose_lines',{receipt:f.receipt,start_line:1,delete_count:2,new_lines:lines});
 assert.equal(result.isError,undefined);assert.equal(value.input_format,'new_lines');
 const current=f.draft.current('a.txt',base);assert.equal(current,lines.join('\r\n')+'\r\n');
 const sandbox={exports:{}};require('node:vm').runInNewContext(current,sandbox);assert.equal(sandbox.exports.pattern,'\\n');assert.equal(sandbox.exports.value,2);
 const stale=await f.call('propose_lines',{receipt:f.receipt,start_line:1,delete_count:1,new_lines:['wrong']});assert.equal(stale.result.isError,true);
});

test('line-array input rejects ambiguous formats, embedded endings, and excessive joined text',async t=>{
 const f=await fixture(t,'anchor\n');const common={receipt:f.receipt,start_line:1,delete_count:1};
 for(const args of [{},{new_text:'x',new_lines:['x']},{new_lines:['one\ntwo']},{new_lines:['one\r']},
  {new_lines:Array(60).fill('x'.repeat(5000))}]){
  const rejected=await f.call('propose_lines',{...common,...args});assert.equal(rejected.result.isError,true);assert.equal(f.draft.files.size,0);
 }
 const good=await f.call('propose_lines',{...common,new_lines:['  indented','next']});
 assert.equal(good.result.isError,undefined);assert.equal(f.draft.current('a.txt','anchor\n'),'  indented\nnext\n');
});

test('an empty line array deletes complete lines and cannot escape an inline selection',async t=>{
 const f=await fixture(t,'first\nsecond\nthird');
 const result=await f.call('propose_lines',{receipt:f.receipt,start_line:2,delete_count:1,new_lines:[]});
 assert.equal(result.result.isError,undefined);assert.equal(f.draft.current('a.txt','first\nsecond\nthird'),'first\nthird');
 const base='outside\nselected\n';const inline=await fixture(t,base,undefined,{file:'a.txt',base,start:8,end:16});
 const denied=await inline.call('propose_lines',{receipt:inline.receipt,start_line:1,delete_count:1,new_lines:['outside edit']});
 assert.equal(denied.result.isError,true);assert.equal(inline.draft.files.size,0);
});

test('insertion after an exact anchor preserves source endings and executes at that boundary',async t=>{
 const base='exports.value = 1;\r\nexports.value += 2;\r\nexports.tail = 4;';const f=await fixture(t,base);
 const {result,value}=await f.call('propose_lines',{receipt:f.receipt,anchor_line:'exports.value += 2;',insert_after:true,
  new_lines:['exports.value *= 3;']});
 assert.equal(result.isError,undefined);assert.equal(value.inserted_after_line,2);
 const current=f.draft.current('a.txt',base);assert.equal(current,'exports.value = 1;\r\nexports.value += 2;\r\nexports.value *= 3;\r\nexports.tail = 4;');
 const sandbox={exports:{}};require('node:vm').runInNewContext(current,sandbox);assert.equal(sandbox.exports.value,9);assert.equal(sandbox.exports.tail,4);
});

test('a repeated anchor needs a matching address and an incorrect address cannot stage an edit',async t=>{
 const f=await fixture(t,'same\nsame\nsuffix\n');
 for(const args of [{anchor_line:'same'},{anchor_line:'same',start_line:3},{anchor_line:'missing',start_line:2}]){
  const denied=await f.call('propose_lines',{receipt:f.receipt,...args,insert_after:true,new_lines:['added']});
  assert.equal(denied.result.isError,true);assert.equal(f.draft.files.size,0);
 }
 const result=await f.call('propose_lines',{receipt:f.receipt,anchor_line:'same',start_line:2,insert_after:true,new_lines:['added']});
 assert.equal(result.result.isError,undefined);assert.equal(f.draft.current('a.txt',await f.read()),'same\nsame\nadded\nsuffix\n');
});

test('after-anchor insertion rejects deletion, a missing anchor, and an unterminated final source line',async t=>{
 const f=await fixture(t,'first\nlast');
 for(const args of [{anchor_line:'first',delete_count:1},{start_line:1},{anchor_line:'last'}]){
  const denied=await f.call('propose_lines',{receipt:f.receipt,...args,insert_after:true,new_lines:['added']});
  assert.equal(denied.result.isError,true);assert.equal(f.draft.files.size,0);
 }
 const eof=await fixture(t,'first\nlast\n');
 const result=await eof.call('propose_lines',{receipt:eof.receipt,anchor_line:'last',insert_after:true,new_lines:['added']});
 assert.equal(result.result.isError,undefined);assert.equal(eof.draft.current('a.txt',await eof.read()),'first\nlast\nadded\n');
});

test('after-anchor insertion retains excerpt, current-source, and inline-selection boundaries',async t=>{
 const f=await fixture(t,'first\nsecond\nthird\n');
 const read=(await f.call('read_file',{file:'a.txt',start_line:2,end_line:2})).value;
 const outside=await f.call('propose_lines',{receipt:read.receipt,anchor_line:'third',insert_after:true,new_lines:['outside']});
 assert.equal(outside.result.isError,true);assert.equal(f.draft.files.size,0);
 const boundary=await f.call('propose_lines',{receipt:read.receipt,anchor_line:'second',insert_after:true,new_lines:['added']});
 assert.equal(boundary.result.isError,undefined);assert.equal(f.draft.current('a.txt',await f.read()),'first\nsecond\nadded\nthird\n');
 const stale=await f.call('propose_lines',{receipt:read.receipt,anchor_line:'second',insert_after:true,new_lines:['stale']});assert.equal(stale.result.isError,true);
 const changed=await fixture(t,'anchor\nend\n');changed.change('anchor\nexternal\n');
 assert.equal((await changed.call('propose_lines',{receipt:changed.receipt,anchor_line:'anchor',insert_after:true,new_lines:['wrong']})).result.isError,true);assert.equal(changed.draft.files.size,0);
 const base='outside\nselected\n';const inline=await fixture(t,base,undefined,{file:'a.txt',base,start:8,end:16});
 assert.equal((await inline.call('propose_lines',{receipt:inline.receipt,anchor_line:'outside',insert_after:true,new_lines:['wrong']})).result.isError,true);assert.equal(inline.draft.files.size,0);
});

test('a rejected anchor offers literal source data and can recover without fuzzy editing',async t=>{
 const base='class Registry:\n    def __init__(self):\n        self.add_command(run_command)\n';const f=await fixture(t,base);
 const bad=await f.call('propose_lines',{receipt:f.receipt,anchor_line:'self.add_command(run_command)',insert_after:true,new_lines:['        self.add_command(config_command)']});
 assert.equal(bad.result.isError,true);assert.equal(f.draft.files.size,0);
 const marker='Source-line suggestions (data only): ';
 const candidates=JSON.parse(bad.value.slice(bad.value.indexOf(marker)+marker.length));
 assert.equal(candidates[0].line,3);assert.equal(candidates[0].text,'        self.add_command(run_command)');
 const fixed=await f.call('propose_lines',{receipt:f.receipt,anchor_line:candidates[0].text,insert_after:true,new_lines:['        self.add_command(config_command)']});
 assert.equal(fixed.result.isError,undefined);assert.equal(f.draft.current('a.txt',base),base+'        self.add_command(config_command)\n');
});

test('anchor suggestions stay bounded inside the read excerpt and never stage a proposed near match',async t=>{
 const base=['outside private_value = 1',...Array.from({length:8},(_,i)=>`    self.add_command(command_${i})`),'self.add_command('+ 'x'.repeat(250)+')'].join('\n')+'\n';
 const f=await fixture(t,base);const read=(await f.call('read_file',{file:'a.txt',start_line:2,end_line:10})).value;
 const bad=await f.call('propose_lines',{receipt:read.receipt,anchor_line:'self.add_command(missing)',insert_after:true,new_lines:['new']});
 assert.equal(bad.result.isError,true);assert.equal(f.draft.files.size,0);assert.ok(!bad.value.includes('private_value'));
 const marker='Source-line suggestions (data only): ';const candidates=JSON.parse(bad.value.slice(bad.value.indexOf(marker)+marker.length));
 assert.equal(candidates.length,3);assert.ok(candidates.every(c=>c.line>=2&&c.line<=10&&c.text.length<=240));assert.ok(JSON.stringify(candidates).length<1000);
 for(const c of candidates)assert.equal(c.text,base.split('\n')[c.line-1]);
 const stale=await f.call('read_file',{file:'a.txt',start_line:2,end_line:10});f.change('external\n');
 const rejected=await f.call('propose_lines',{receipt:stale.value.receipt,anchor_line:candidates[0].text,insert_after:true,new_lines:['wrong']});
 assert.equal(rejected.result.isError,true);assert.equal(f.draft.files.size,0);
});

test('inserting a copied declaration warns that the original remains and permits an exact repair',async t=>{
 const base='def run_command():\n    return 1\n';const f=await fixture(t,base);
 const duplicate=await f.call('propose_lines',{receipt:f.receipt,anchor_line:'def run_command():',new_lines:['def run_command():','    return 2']});
 assert.equal(duplicate.result.isError,undefined);assert.match(duplicate.value.warning,/keeps both versions/);assert.match(duplicate.value.warning,/delete_count: 1/);
 const current=f.draft.current('a.txt',base);assert.equal(current,'def run_command():\n    return 2\n'+base);
 const repair=await f.call('propose_write',{file:'a.txt',old_text:current,new_text:'def run_command():\n    return 2\n'});
 assert.equal(repair.result.isError,undefined);assert.equal(f.draft.current('a.txt',base),'def run_command():\n    return 2\n');
});

test('inline feedback does not infer missing file bindings from only the selected text',async t=>{
 const selected='commands.register(oldHandler);',base='const outsideSecret = 1;\n'+selected+'\nother();\n';
 const start=base.indexOf(selected),selection={file:'a.js',base,start,end:start+selected.length};
 const f=await fixture(t,base,undefined,selection,'a.js');
 const edited=await f.call('propose_write',{file:'a.js',old_text:selected,new_text:'commands.register(newHandler);'});
 assert.equal(edited.result.isError,undefined);assert.equal(edited.value.new_registration_references,undefined);
 assert.equal(edited.value.preview[0].text,'commands.register(newHandler);');assert.ok(!JSON.stringify(edited.value).includes('outsideSecret'));
});
