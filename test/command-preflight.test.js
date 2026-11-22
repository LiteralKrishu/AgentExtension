const assert=require('node:assert/strict');
const {test}=require('node:test');
const {approvalInputError}=require('../src/forge');
const {diagnosticCommand}=require('../src/workspace');

test('known interpreters need an explicit program before command approval',()=>{
 for(const command of ['node','nodejs','python','python3.14','ruby','perl','bash','sh','zsh','node.exe']){
  for(const args of [[],['-']]){
   const error=approvalInputError({name:'run_command',args:{command,args}});
   assert.match(error,/needs a script/);assert.match(error,/No command was run/);assert.equal(diagnosticCommand(command,args),true);
  }
 }
 assert.match(approvalInputError({name:'run_command',args:{command:'node'}}),/needs a script/);
});

test('script paths, tests, explicit version probes and standalone tools retain their contracts',()=>{
 for(const [command,args]of [['node',['--test','calc.test.js']],['node',['check.js']],['python',['-m','pytest','tests']],
  ['python3',['-c','print(1)']],['node',['-v']],['python3',['--version']],['pytest',[]],['git',[]]]){
  assert.equal(approvalInputError({name:'run_command',args:{command,args}}),'');
 }
 assert.match(approvalInputError({name:'run_command',args:{command:'node test.js'}}),/each argument in args/);
});
