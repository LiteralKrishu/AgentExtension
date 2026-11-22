function requireLocalEndpoint(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password) throw new Error('Local-only evaluation requires a loopback model endpoint.');
  return url;
}
module.exports = { requireLocalEndpoint };
