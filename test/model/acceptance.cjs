// These assertions run outside model context against the applied disposable checkout.
const nodeCheck = (name, script) => ({ name, command: 'node', args: ['-e', script] });
const calcAcceptance = [nodeCheck('Arithmetic behavior and unchanged subtraction',
  "const a=require('node:assert/strict'),m=require('./calc'); for(const [x,y] of [[1,2],[0,0],[-3,2],[1.5,2.5]]){a.equal(m.add(x,y),x+y);a.equal(m.sub(x,y),x-y);}"),
{ name: 'Project tests', command: 'node', args: ['--test', 'calc.test.js'] }];
const configAcceptance = [nodeCheck('Selected config and unchanged production config',
  "const a=require('node:assert/strict'),fs=require('node:fs');a.deepEqual(JSON.parse(fs.readFileSync('config/dev.json','utf8')),{logLevel:'debug'});a.deepEqual(JSON.parse(fs.readFileSync('config/prod.json','utf8')),{logLevel:'warn'});")];
const mulAcceptance = [nodeCheck('Multiplication behavior and existing exports',
  "const a=require('node:assert/strict'),m=require('./calc');for(const [x,y] of [[2,3],[0,7],[-3,2],[1.5,2]]) a.equal(m.mul(x,y),x*y);a.equal(m.add(2,3),5);a.equal(m.sub(5,2),3);")];
const flaskAcceptance = [
  { name: 'Flask CLI regression tests', command: 'python', args: ['-c',
    "import sys; sys.path.insert(0, 'src'); import pytest; sys.exit(pytest.main(['-p', 'no:asyncio', 'tests/test_cli.py', '-q']))"] },
  { name: 'Flask config behavior and help', command: 'python', args: ['-c', [
    'import json, sys',
    'sys.path.insert(0, "src")',
    'from flask import Flask',
    'from flask.cli import FlaskGroup',
    'from click.testing import CliRunner',
    'app = Flask("acceptance")',
    'secrets = {"DEMO_SECRET": "s", "DEMO_PASSWORD": "p", "DEMO_TOKEN": "t", "DEMO_KEY": "k", "PREFIX_SECRET_SUFFIX": "v"}',
    'app.config.update(secrets)',
    'app.config.update(DEMO_LABEL="visible", DEMO_NUMBER=42, DEMO_BOOL=False, DEMO_NONE=None)',
    'cli = FlaskGroup(create_app=lambda: app)',
    'runner = CliRunner()',
    'help_result = runner.invoke(cli, ["--help"])',
    'assert help_result.exit_code == 0 and "config" in help_result.output',
    'result = runner.invoke(cli, ["config"])',
    'assert result.exit_code == 0, result.output',
    'data = json.loads(result.output)',
    'assert all(data[key] == "***" for key in secrets)',
    'assert data["DEMO_LABEL"] == "visible" and data["DEMO_NUMBER"] == 42',
    'assert data["DEMO_BOOL"] is False and data["DEMO_NONE"] is None',
  ].join('\n')] },
];

module.exports = { calcAcceptance, configAcceptance, mulAcceptance, flaskAcceptance };
