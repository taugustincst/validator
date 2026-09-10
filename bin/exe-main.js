// Entry point of the packaged executable (built by build-exe.mjs into one file with the engine).
//   ecw-validator.exe                      → starts the local app on 127.0.0.1 and opens the browser
//   ecw-validator.exe validate …           → the command line, exactly like `ecw-validate`
//   ecw-validator.exe --port 8787 --no-open
// Nothing is installed, nothing leaves the computer: the page is served on loopback only.
import { spawn } from 'node:child_process';
import { main as cli } from './ecw-validate.js';

export async function run(argv) {
  const COMMANDS = ['validate', 'inspect', 'serve', 'template', 'document', 'example', 'help'];
  if (argv.some(a => COMMANDS.includes(a)) || argv.includes('--help') || argv.includes('-h') || argv.includes('--version')) return cli(argv);
  const portArg = argv.indexOf('--port');
  const port = portArg >= 0 ? Number(argv[portArg + 1]) || 0 : 0;   // 0: any free port
  const open = !argv.includes('--no-open');
  const { serve } = globalThis.__ECW_SERVER;
  const s = await serve({ port, host: '127.0.0.1', page: globalThis.__ECW_PAGE || null });
  const url = `http://127.0.0.1:${s.port}/`;
  process.stdout.write(`eCW Security Settings Validator\n\n  ${url}\n\nThe app is open in your browser (if it did not open, paste the address above into Chrome or Edge).\nKeep this window open while you work; close it or press Ctrl+C to stop.\n`);
  if (open) openBrowser(url);
  const stop = () => { process.stdout.write('\nstopping\n'); s.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return new Promise(() => {});   // keep serving
}

function openBrowser(url) {
  try {
    const p = process.platform === 'win32' ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
      : process.platform === 'darwin' ? spawn('open', [url], { detached: true, stdio: 'ignore' })
      : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    p.on('error', () => {}); p.unref();
  } catch { /* the address is printed; the user can open it by hand */ }
}
