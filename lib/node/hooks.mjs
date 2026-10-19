// Node module hooks: .wasm imports become compiled WebAssembly.Module objects, .json imports become modules.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function load(url, context, next) {
  if (url.startsWith('file:') && url.endsWith('.wasm')) {
    return { format: 'module', shortCircuit: true, source: `import fs from 'node:fs'; export default new WebAssembly.Module(fs.readFileSync(${JSON.stringify(fileURLToPath(url))}));` };
  }
  if (url.startsWith('file:') && url.endsWith('.json')) {
    return { format: 'module', shortCircuit: true, source: 'export default ' + fs.readFileSync(fileURLToPath(url), 'utf8') };
  }
  return next(url, context);
}
