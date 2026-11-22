const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { verifyDraft } = require('./model/verify.cjs');
const { flaskAcceptance } = require('./model/acceptance.cjs');

test('pinned Flask acceptance passes a working command and rejects a registered wrong command', {
  skip: !process.env.AGENTEXTENSION_TEST_FLASK_ROOT && 'Set AGENTEXTENSION_TEST_FLASK_ROOT and prepare its Python toolchain.',
  timeout: 120_000,
}, async () => {
  const source = process.env.AGENTEXTENSION_TEST_FLASK_ROOT;
  const before = await fs.readFile(path.join(source, 'src/flask/cli.py'), 'utf8');
  const command = [
    '@click.command("config")',
    '@with_appcontext',
    'def config_command():',
    '    import json',
    '    import re',
    '    values = {key: "***" if re.search("SECRET|PASSWORD|TOKEN|KEY", key, re.I) else value for key, value in current_app.config.items()}',
    '    click.echo(json.dumps(values, default=str))',
    '',
    '',
  ].join('\n');
  const after = before.replace('class FlaskGroup(AppGroup):', command + 'class FlaskGroup(AppGroup):')
    .replace('            self.add_command(routes_command)', '            self.add_command(routes_command)\n            self.add_command(config_command)');
  assert.notEqual(after, before);
  const changes = [{ file: 'src/flask/cli.py', before, after }];
  const options = { source, changes, acceptance: flaskAcceptance, acceptanceInputs: require('./model/flask-inputs.json').inputs,
    allowedFiles: file => file === 'src/flask/cli.py' };
  const good = await verifyDraft(options);
  assert.equal(good.status, 'complete', JSON.stringify(good));
  const wrong = after.replace('click.echo(json.dumps(values, default=str))', 'click.echo("{}")');
  const bad = await verifyDraft({ ...options, changes: [{ file: changes[0].file, before, after: wrong }] });
  assert.equal(bad.status, 'failed', JSON.stringify(bad));
  assert.equal(bad.checks.find(check => check.name === 'Flask config behavior and help').ok, false);
  assert.equal(await fs.readFile(path.join(source, 'src/flask/cli.py'), 'utf8'), before);
});
