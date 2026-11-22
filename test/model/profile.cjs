// Record the settings used by the host, rather than inferring them from a model name.
function compactionOption(argv) {
  if (argv.includes('--compaction') && argv.includes('--no-compaction')) {
    throw new Error('Choose either --compaction or --no-compaction.');
  }
  return argv.includes('--compaction');
}

function executionSettings(settings) {
  return {
    compaction: settings.compaction !== false,
    turnTimeoutSeconds: settings.turnTimeoutSeconds ?? 600,
    workerTimeoutSeconds: settings.workerTimeoutSeconds ?? 180,
    fallbackModel: settings.fallbackModel ?? '',
  };
}

module.exports = { compactionOption, executionSettings };
