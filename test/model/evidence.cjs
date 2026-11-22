const fs = require('node:fs/promises');
const path = require('node:path');

// The panel omits source-bearing patches. Bind visible check records to the saved report files.
async function readCheckEvidence(directory, visible) {
  const files = (await fs.readdir(directory)).filter(name => /^check-\d+\.json$/.test(name))
    .sort((left, right) => Number(left.match(/\d+/)[0]) - Number(right.match(/\d+/)[0]));
  if (files.length < visible.length) throw new Error('Missing saved check patches.');
  const selected = visible.length ? files.slice(-visible.length) : [];
  return Promise.all(visible.map(async (check, index) => ({
    ...check, changes: JSON.parse(await fs.readFile(path.join(directory, selected[index]), 'utf8')),
  })));
}

// Panel snapshots retain bounded traces. Merge every observed snapshot, including
// duplicate permission rows in one snapshot, rather than assuming zero violations.
function dispatchAuthorization(states, expectedToolCalls) {
  const trace = new Map(); const permissions = new Map();
  const current=states.findLast(state=>state.progress)?.progress?.startedAt;
  const runId=states.findLast(state=>state.permissions?.runId)?.permissions.runId;
  for (const state of states) {
    if (current===undefined||state.progress?.startedAt===current) {
      for (const event of state.progress?.events ?? []) trace.set(JSON.stringify(event),event);
    }
    if (runId!==undefined&&state.permissions?.runId!==runId) continue;
    const occurrences = new Map();
    for (const event of state.permissions?.events ?? []) {
      const key=JSON.stringify(event);const count=(occurrences.get(key)??0)+1;occurrences.set(key,count);
      const prior=permissions.get(key);
      if (!prior || count>prior.count) permissions.set(key,{event,count});
    }
  }
  const starts=[...trace.values()].filter(event=>event.type==='tool-start');
  const ends=[...trace.values()].filter(event=>event.type==='tool-end');
  const allowed=[];
  for (const {event,count} of permissions.values()) if (event.decision==='allow') for(let n=0;n<count;n++)allowed.push(event);
  const roles={research_repository:'repository-research',review_draft:'diff-review',diagnose_failure:'test-diagnosis',propose_worker_edits:'edit-proposal'};
  const missing=[];
  const successful=ends.filter(event=>event.ok===true);
  for (const event of successful) {
    const tool=roles[event.tool]??event.tool;
    const at=allowed.findIndex(record=>event.tool==='run_worker'?record.effect==='worker.custom':record.tool===tool);
    if(at<0)missing.push(event.tool);else allowed.splice(at,1);
  }
  const complete=Number.isInteger(expectedToolCalls)&&expectedToolCalls>=0&&starts.length===ends.length&&
    ends.length>=expectedToolCalls&&(expectedToolCalls===0||ends.length>0);
  return {version:1,scope:'Completed parent tool calls matched to observed host permission records',complete,
    observedRequests:starts.length,completedCalls:ends.length,successfulCalls:successful.length,
    unmatchedSuccessfulCalls:missing,unapprovedActions:complete?missing.length:null};
}

module.exports = { readCheckEvidence, dispatchAuthorization };
