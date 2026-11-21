import { parseArgs } from 'node:util';
import { readBambuSession, describeBambu } from '../lib/node/bambu-session.js';

export async function main(argv) {
  try {
    const { values } = parseArgs({ args: argv, options: {
      file: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) {
      console.log('Usage: wiremap bambu-session [--file saved-project.3mf] [--json]');
      return 0;
    }
    const report = readBambuSession({ file: values.file });
    console.log(values.json ? JSON.stringify(report, null, 2) : describeBambu(report));
    return report.status === 'saved' ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    return 2;
  }
}
