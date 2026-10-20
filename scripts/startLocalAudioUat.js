// Deliberately validate process settings BEFORE server.js can load the usual .env.
// Never use this entry point to silently fall back to a historical database.
const { localAudioUat } = require('../services/localAudioUat');
try {
  if (process.env.ISPEAK_LOCAL_AUDIO_UAT !== 'true' || !localAudioUat()) {
    throw new Error('Local UAT must be explicitly configured');
  }
} catch {
  console.error('Isolated local audio UAT configuration is missing or unsafe; no service started.');
  process.exit(1);
}
const { startServer, shutdown } = require('../server');
startServer().catch(() => {
  console.error('Isolated local audio UAT startup failed.');
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  shutdown(signal).then(() => process.exit(0)).catch(() => process.exit(1));
});
