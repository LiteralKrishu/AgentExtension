# Managed checks and local services

Use the container execution environment for checks that need installed dependencies or a local service. Install and start Docker Desktop on macOS. Linux needs a running Docker engine.

Set `agentextension.executionEnvironment` to `container`. Dependency setup uses the profile registry. Check execution has no network access. The first setup resolves the image to an immutable repository digest. A cache is reusable only after setup finishes and its completion marker matches the dependency digest.

Ordinary Node.js checks need package.json and package-lock.json at the workspace root. Python checks need requirements.txt. Lifecycle scripts and Python source builds require the machine setting `agentextension.container.allowLifecycleScripts`. Review that choice before use. The registry is named in the setup command; setup traffic is not restricted by a destination firewall.

## Declare a service-backed check

Add a declaration to `agentextension.container.checks` in VS Code settings. The host matches the exact executable and argument list. The declaration supplies the working directory, literal environment values, service commands, readiness checks, and lease.

```json
{
  "agentextension.executionEnvironment": "container",
  "agentextension.container.checks": [
    {
      "name": "integration",
      "command": "node",
      "args": ["check.js"],
      "cwd": "app",
      "profile": "node",
      "leaseSeconds": 30,
      "env": { "GREETING": "Hello" },
      "services": [
        {
          "name": "web",
          "command": "node",
          "args": ["server.js"],
          "cwd": "app",
          "ready": {
            "type": "http",
            "port": 8123,
            "path": "/health",
            "status": 200,
            "timeoutMs": 5000
          }
        }
      ]
    }
  ]
}
```

The agent can use the read-only managed_checks tool to find configured names and exact command arguments. For this declaration, run `node` with arguments `["check.js"]`. The host runs it from app. A different argument list uses the ordinary container check path. Approval shows the selected image, service names and ports, lease, and environment variable names. Environment values are not copied into that summary or the discovery tool. Do not put credentials in workspace settings.

HTTP readiness uses the declared status code. TCP readiness checks a successful connection. Both use 127.0.0.1 inside the job. Each service needs a unique name and readiness port. Service arguments use the same executable-and-arguments format as checks. A working directory must stay within the snapshot.

The node profile runs Node.js services and checks. The browser profile uses the pinned Playwright image for a controlled project smoke test. Install a matching playwright-core version in the project lockfile. The current browser image is v1.62.1-noble. It includes browser binaries and their system libraries; the project supplies the Playwright package. See the [Playwright image documentation](https://playwright.dev/docs/docker).

## Scope and limits

Each job gets one private container. Its services and check share loopback. The job publishes no host port and has no external network interface. There is no cross-container service protocol. Processes inside one job share its local ports.

The input snapshot and dependency cache are mounted read-only. A private working copy is made in a 512 MiB temporary filesystem. That space also holds temporary browser files and the copied dependencies. Oversized copies fail. The input limit is 10,000 files and 128 MiB. Each job has two CPUs, 2 GiB of memory, and a 256-process limit. A check can declare at most three services. Its lease is at most 120 seconds. A readiness deadline is at most 20 seconds. Command output is bounded.

The host waits for Docker to remove the job container before it returns a result. A service that exits early, a readiness failure, a failed check, an expired lease, cancellation, or unconfirmed cleanup prevents a passing result. Source changes during a check make its result stale. Writes inside the job do not stage editor changes.

The run report records startup, check, process cleanup, and host-confirmed container removal separately. Container-runner status is process output. It is not an independent security attestation. The environment digest includes the image, dependencies, managed declaration, and runner.

## Verification

Run `AGENTEXTENSION_TEST_DOCKER=1 node --test --test-concurrency=1 test/execution-environment-docker.test.js test/execution-services-docker.test.js` with Docker running. These fixtures cover pinned Node.js and Python dependencies, empty Node.js projects, service readiness, blocked egress, occupied job ports, service crashes, leases, cancellation, a Chromium smoke, stale source, and container removal.

Python setup hashes local `-r` and `-c` input files recursively. Unsupported includes and local-package inputs fail before cache creation. See [the dependency subset and cache limits](agent-capability-upgrade/RELEASE-RISK-FIXES.md#python-dependency-subset).
