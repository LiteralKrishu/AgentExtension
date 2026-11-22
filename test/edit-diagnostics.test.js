const assert=require('node:assert/strict');
const {test}=require('node:test');
const {registrationReferences}=require('../src/edit-diagnostics');
const {execFileSync}=require('node:child_process');
const entry=(base,text,after=text)=>({base,text,hunks:[{after}]});

test('new registration-only names get bounded advisory guidance until their definition is added',()=>{
 const base='def run_command():\n    return 1\ncli.add_command(run_command)\n';
 const text=base+'cli.add_command(config_command)\n';
 const hints=registrationReferences('cli.py',entry(base,text,'cli.add_command(config_command)\n'));
 assert.equal(hints.length,1);assert.equal(hints[0].name,'config_command');assert.equal(hints[0].provenance,'inferred-syntax');assert.match(hints[0].note,/does not prove/);
 assert.deepEqual(registrationReferences('cli.py',entry(base,text+'def config_command():\n    return 2\n')),[]);
});

test('declarations, imports, parameters and other local uses suppress the narrow inference',()=>{
 for(const prefix of ['from commands import config_command\n','from commands import other as config_command\n',
  'config_command = make_command()\n','def config_command():\n    return 2\n',
  'def setup(config_command):\n']){
  const after='    cli.add_command(config_command)\n';
  assert.deepEqual(registrationReferences('cli.py',entry(prefix,prefix+after,after)),[]);
 }
 for(const prefix of ['import {configCommand} from "./commands";\n','const {configCommand} = require("./commands");\n',
  'function configCommand() {}\n','class App { constructor(configCommand) {\n']){
  const after='  commands.registerCommand("config", configCommand);\n';
  assert.deepEqual(registrationReferences('commands.js',entry(prefix,prefix+after,after)),[]);
 }
});

test('new JavaScript and TypeScript registration arguments are distinguished from strings, members and callbacks',()=>{
 for(const file of ['commands.js','commands.ts','commands.cjs','commands.mjs','commands.tsx']){
  const added='commands.registerCommand("config", configCommand);\n';
  assert.equal(registrationReferences(file,entry('',added))[0].name,'configCommand');
 }
 for(const line of ['commands.registerCommand("config", handlers.configCommand);\n','commands.registerCommand("config", () => 1);\n',
  'commands.register("config");\n','// commands.register(configCommand);\n','# cli.add_command(config_command)\n']){
  assert.deepEqual(registrationReferences('commands.js',entry('',line)),[]);
 }
});

test('preexisting registrations, unsupported files, and wildcard imports do not create new warnings',()=>{
 const old='cli.add_command(existing_command)\n';
 assert.deepEqual(registrationReferences('cli.py',entry(old,old+'value = 1\n')),[]);
 assert.deepEqual(registrationReferences('notes.md',entry('',old)),[]);
 const wildcard='from commands import *\n';
 assert.deepEqual(registrationReferences('cli.py',entry(wildcard,wildcard+old)),[]);
 assert.deepEqual(registrationReferences('cli.py',null),[]);
});

test('repeated new registrations remain one hint per name and output is capped',()=>{
 const duplicated='cli.add_command(new_command)\nother.add_command(new_command)\n';
 assert.equal(registrationReferences('cli.py',entry('',duplicated)).length,1);
 const many=Array.from({length:20},(_,i)=>`cli.add_command(handler_${i})`).join('\n');
 assert.equal(registrationReferences('cli.py',entry('',many)).length,5);
});

test('large blank drafts and unfinished registrations stay within a bounded scan',()=>{
 const script='const {registrationReferences}=require('+JSON.stringify(require.resolve('../src/edit-diagnostics'))+');'+
  'const text=require("node:fs").readFileSync(0,"utf8");'+
  'for(const file of ["registry.js","registry.py"])if(registrationReferences(file,{base:"",text,hunks:[{after:text}]}).length)throw Error("Unexpected hint");';
 const text='\n'.repeat(120000)+'from commands import\nregistry.register(';
 execFileSync(process.execPath,['-e',script],{input:text,timeout:5000});
});
