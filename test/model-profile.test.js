const assert=require('node:assert/strict');
const {test}=require('node:test');
const {spawnSync}=require('node:child_process');
const path=require('node:path');

test('the manifest exposes explicit compaction without changing frozen task budgets',()=>{
  const runner=path.join(__dirname,'model/run.cjs');
  const list=flags=>{
    const result=spawnSync(process.execPath,[runner,'--corpus','--list',...flags],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    return JSON.parse(result.stdout);
  };
  const baseline=list([]), enabled=list(['--compaction']), disabled=list(['--no-compaction']);
  assert.equal(baseline.executionSettings.compaction,false);
  assert.equal(enabled.executionSettings.compaction,true);
  assert.deepEqual(disabled,baseline);
  assert.deepEqual(enabled.tasks,baseline.tasks);
  assert.equal(enabled.repetitions,3);
  const conflict=spawnSync(process.execPath,[runner,'--corpus','--list','--compaction','--no-compaction'],{encoding:'utf8'});
  assert.notEqual(conflict.status,0);
  assert.match(conflict.stderr,/Choose either/);
});
