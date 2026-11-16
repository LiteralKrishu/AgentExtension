const path = require('node:path');

function webhookUrl(value) {
  const url = new URL(value);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS webhook URL without credentials, query parameters, or fragments. Local HTTP is allowed on loopback.');
  }
  return url.href;
}

function notificationPayload(storage, record) {
  const report = record.report ? path.relative(storage, record.report).split(path.sep).join('/') : null;
  if (report && !/^reports\/[a-f0-9]{24}\/[a-f0-9-]{36}\/report\.md$/.test(report)) throw new Error('Invalid scheduled report location.');
  return { outcome: record.status, report };
}

async function deliverNotification(destination, payload, fetchFn = fetch) {
  try {
    const response = await fetchFn(webhookUrl(destination), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    await response.body?.cancel();
    return response.ok ? { status: 'delivered' } : { status: 'failed', reason: `Webhook returned HTTP ${response.status}.` };
  } catch {
    return { status: 'failed', reason: 'Webhook unavailable or delivery timed out.' };
  }
}

module.exports = { webhookUrl, notificationPayload, deliverNotification };
