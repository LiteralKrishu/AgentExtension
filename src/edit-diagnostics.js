// Bounded lexical hints, not a compiler or a cross-file name resolver.
function registrations(text) {
  return [...text.matchAll(/^[ \t]*(?:[A-Za-z_$][\w$]*\.)+(?:add_command|addCommand|register|registerCommand|registerTool)\(\s*(?:(?:'[^'\r\n]{0,200}'|"[^"\r\n]{0,200}")\s*,\s*)?([A-Za-z_$][\w$]{0,99})(?=\s*(?:,|\)))/gm)]
    .map(match => match[1]);
}

function counts(values) {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function registrationReferences(file, entry) {
  if (!entry || !/\.(?:py|[cm]?[jt]sx?)$/.test(file)) return [];
  // Wildcard imports can provide names which never appear elsewhere in this file.
  if (file.endsWith('.py') && /^[ \t]*from[ \t]+[\w.]+[ \t]+import[ \t]*\*/m.test(entry.text)) return [];
  const previous = new Set(registrations(entry.base ?? ''));
  const registered = counts(registrations(entry.text));
  const occurrences = counts(entry.text.match(/[A-Za-z_$][\w$]*/g) ?? []);
  const added = new Set(registrations(entry.hunks.map(hunk => hunk.after).join('\n')));
  return [...added].filter(name => !previous.has(name) && occurrences.get(name) === registered.get(name)).slice(0, 5)
    .map(name => ({ name, provenance: 'inferred-syntax',
      note: 'This new name appears only as a registration argument in this file. Confirm its definition or import and implement missing behavior before checking the draft. This lexical hint does not prove that the name is undefined.' }));
}

module.exports = { registrationReferences };
