const MODES = {
  fixtures,
  "g7-setup": setup,
  "g7-u39": u39,
  "g7-u40": u40,
  "g7-u41": u41,
  "g7-u42": u42,
  "g7-u43": u43,
  "g7-u44": u44,
  "g7-u45": u45,
  "g7-u46": u46,
  "g7-u47": u47,
  "g7-u48": u48,
  "g7-u49": u49,
  "g7-u50": u50,
  "g7-u51": u51,
  "g7-u52": u52,
  "g7-u53": u53,
  "g7-u54": u54,
  "g7-browser-item": browserItem,
};

const runStep = MODES[config.mode];
if (!runStep) {
  console.error(`unknown mode ${config.mode}`);
  process.exit(2);
}
try {
  await runStep();
  setTimeout(() => process.exit(0), 200).unref();
} catch (err) {
  console.error(`gate7 ${config.mode} failed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
}
