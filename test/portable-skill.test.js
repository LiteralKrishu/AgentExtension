const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PluginPackages, encodePluginPackage } = require('../src/plugin-packages');
const { SkillRegistry } = require('../src/skills');
const { PluginRegistry } = require('../src/plugins');
async function fixture(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ae-portable-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const skill=path.join(root,'portable-review');await fs.mkdir(path.join(skill,'references'),{recursive:true});
 const source=path.join(skill,'SKILL.md');const text='---\nname: portable-review\ndescription: Review portable inputs.\nmetadata:\n  author: Fixture Publisher\n  version: 1.2.3\nallow_implicit_invocation: false\nmodel: foreign-model\nhooks: forbidden\nagent: foreign-agent\nallowed-tools: Bash\n---\nRead references/check.md before review.\n';
 await fs.writeFile(source,text);await fs.writeFile(path.join(skill,'references/check.md'),'Review the source.');await fs.writeFile(path.join(skill,'settings.json'),'Foreign model and hook settings.');
 return {root,skill,source,text,packages:new PluginPackages(path.join(root,'store'))};
}
test('portable skill preview preserves content and explicit-only scope while showing unsupported settings',async t=>{
 const f=await fixture(t);let previews=0;
 const plugin=await f.packages.import(f.source,[],async candidate=>{
  previews++;assert.equal(candidate.publisher,'Fixture Publisher');assert.equal(candidate.version,'1.2.3');assert.equal(candidate.skills[0].explicitOnly,true);
  for(const name of ['model','hooks','agent','allowed-tools','settings.json'])assert.ok(candidate.importWarnings.some(warning=>warning.includes(name)),name);
  assert.deepEqual(candidate.capabilities,['skill.read']);assert.deepEqual(candidate.workers,[]);assert.deepEqual(candidate.hooks,[]);return true;
 });
 assert.equal(previews,1);assert.equal(plugin.files.get('skills/portable-review/SKILL.md'),f.text);
 const registry=new SkillRegistry([]);registry.addPinned(plugin.skills);assert.equal(await registry.resource(plugin.skills[0].id,'references/check.md'),'Review the source.');assert.deepEqual(registry.eligible(),[]);
 const portable=path.join(f.root,'shared.json');await fs.writeFile(portable,encodePluginPackage(plugin));
 const second=await new PluginPackages(path.join(f.root,'recipient')).import(portable,[],()=>true);assert.equal(second.pin.digest,plugin.pin.digest);
 const plugins=new PluginRegistry([],[],f.packages);await plugins.discover();const pin=(await f.packages.load(plugin.id)).pin;
 await fs.appendFile(f.source,'Unapproved changed instructions.');const changed=await f.packages.import(f.source,[],()=>true);assert.notEqual(changed.pin.digest,pin.digest);await plugins.discover();await assert.rejects(plugins.verify([pin]),/changed/);
});
test('declined, linked, oversized, or invalid portable imports do not replace the installed package',async t=>{
 const f=await fixture(t);assert.equal(await f.packages.import(f.source,[],()=>false),undefined);assert.deepEqual(await f.packages.list(),[]);
 const first=await f.packages.import(f.source,[],()=>true);
 await fs.symlink(path.join(f.skill,'references/check.md'),path.join(f.skill,'references/link.md'));await assert.rejects(f.packages.import(f.source,[],()=>true),/symlinks/);await fs.rm(path.join(f.skill,'references/link.md'));
 await fs.writeFile(f.source,f.text+'x'.repeat(24000));await assert.rejects(f.packages.import(f.source,[],()=>true),/size limit/);assert.equal((await f.packages.load(first.id)).pin.digest,first.pin.digest);
});

test('portable activation flags require booleans and declared scripts retain local isolation requirements',async t=>{
 const f=await fixture(t);
 await fs.writeFile(f.source,f.text.replace('allow_implicit_invocation: false','allow_implicit_invocation: "false"'));
 await assert.rejects(f.packages.import(f.source,[],()=>true),/must be a boolean/);
 await fs.mkdir(path.join(f.skill,'scripts'));await fs.writeFile(path.join(f.skill,'scripts/check.cjs'),'module.exports = () => "fixture";');
 await fs.writeFile(f.source,f.text.replace('allow_implicit_invocation: false','allow_implicit_invocation: false\nscripts: [check]'));
 const plugin=await f.packages.import(f.source,[],()=>true);assert.deepEqual(plugin.capabilities,['skill.read','skill.script']);assert.match(plugin.skills[0].scriptSources.get('check'),/fixture/);
 const registry=new SkillRegistry([]);registry.addPinned(plugin.skills);assert.ok((await registry.script(plugin.skills[0].id,'check')).source);
 assert.equal(plugin.connectors.length,0);assert.equal(plugin.customHooks.length,0);assert.equal(plugin.roles.length,0);
});

test('the editor shows unsupported portable settings before installation',async t=>{
 const f=await fixture(t);const {startHost}=require('./helpers/host.cjs');const host=await startHost(t,{root:f.root,settings:{}});
 host.answers.push({kind:'open',value:[{scheme:'file',fsPath:f.source}]},{kind:'modal',value:()=>{
  const detail=host.shown.warning.at(-1).detail;for(const key of ['model','agent','hooks','allowed-tools'])assert.ok(detail.includes(key));return 'Import plugin';
 }});
 await host.command('importPlugin');await host.waitFor(state=>state.status?.startsWith('Imported portable-review 1.2.3'),5000,'import preview');assert.deepEqual(host.answers,[]);assert.equal((host.state().plugins??[]).some(plugin=>plugin.id==='portable-review'),false,'Import does not enable a plugin.');
});
