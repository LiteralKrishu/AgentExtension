# Worker queue

Each interactive run accepts at most four worker calls. The default is two active workers. Other calls wait in order. Set `agentextension.workerConcurrency` to one to reduce load on a local model. The release setting accepts only one or two.

The worker deadline includes queue time and one permitted retry. Cancellation stops queued and active requests. A queued request checks the current permission before it starts. A failed or cancelled request still counts toward the four-call limit.

Parent and worker calls share the run time, reported token use, and tool budget. Reported usage is counted during streaming, including turns that fail. Repeated usage updates add only the increase. Reaching a limit cancels the worker pool. Providers can report token use late. An in-flight response can therefore spend tokens before the host receives its usage. This is not an exact token ceiling.

An approved custom repository role can declare `read_file`, `search_workspace`, or both. It also needs `worker.read` and the parent's workspace read scope. Access covers only files explicitly named for that worker: at most six files, with up to 240 lines and 12,000 characters captured per file. Search uses literal text and reports partial coverage. Search and read share a limit of three calls.

The host binds captured files to their source hashes. A changed file cannot supply an extra read or search result. If a source changes before the report ends, the advice is marked stale. A worker cannot expand its file scope, run commands, or create child workers.

Use `agentextension.workerRoleModels` to select an optional registered model name for a role ID. For example:

```json
{
  "agentextension.workerConcurrency": 1,
  "agentextension.workerRoleModels": {
    "repository-research": "local/research"
  }
}
```

This setting selects an existing runtime model. It cannot declare an endpoint or credentials. Worker prompts still omit parent chat, notes, credentials, and permission grants. A separate worker draft requires parent merge and user hunk review.

The [scripted comparison](agent-capability-upgrade/evidence/worker-queue-2026-11-23.json) covers queue mechanics. It does not measure local model quality or throughput. A real model comparison remains pending. The release maximum stays at two.

Cancellation uses the public [Node.js AbortSignal interface](https://nodejs.org/docs/latest-v24.x/api/globals.html#class-abortsignal).
