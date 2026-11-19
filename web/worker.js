// Web Worker that runs the labs' Python (Pyodide) off the page's main thread, so a lab never freezes the page.
// Messages in: {id, type: 'run' | 'ensure' | 'raw', name, params}; 'raw' hands over an array kept for the GPU mode as bytes. Messages out: {type: 'ready'} | {type: 'failed', error} | {id, result} | {id, error}.
// Plain postMessage with JSON strings: no SharedArrayBuffer needed, so it works on GitHub Pages without COOP/COEP.
import { loadPyodide } from 'https://cdn.jsdelivr.net/pyodide/v314.0.3/full/pyodide.mjs';  // the Pyodide PyScript 2026.7.3 uses

const HOME = '/home/pyodide';
const boot = (async () => {
  const py = await loadPyodide();
  // pyscript.toml lists the packages and maps the lab sources (../1-lab/...) to ./labs/... in the Python file system
  py.FS.writeFile(`${HOME}/pyscript.toml`, await (await fetch('./pyscript.toml')).text());
  const { packages = [], files = {} } = JSON.parse(py.runPython(`import json, tomllib; json.dumps(tomllib.load(open('${HOME}/pyscript.toml', 'rb')))`));
  const fetched = Promise.all(Object.entries(files).map(async ([src, dest]) => {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Could not load ${src} (HTTP ${res.status})`);
    const path = `${HOME}/${dest.replace(/^\.\//, '')}`;
    py.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
    py.FS.writeFile(path, new Uint8Array(await res.arrayBuffer()));
  }));
  await Promise.all([py.loadPackage(packages), fetched]);
  const res = await fetch('./bridge.py');
  if (!res.ok) throw new Error(`Could not load bridge.py (HTTP ${res.status})`);
  py.runPython(`import os, sys\nos.chdir('${HOME}')\nif '${HOME}' not in sys.path: sys.path.insert(0, '${HOME}')`);
  await py.runPythonAsync(await res.text());
  return py.globals;
})();

boot.then(() => postMessage({ type: 'ready' }), (e) => postMessage({ type: 'failed', error: String(e?.message || e) }));

onmessage = async ({ data: { id, type, name, params } }) => {
  try {
    const g = await boot;
    if (type === 'raw') {
      const bytes = g.get('showcase').raw_take(name);
      const result = bytes.toJs();
      bytes.destroy();
      return postMessage({ id, result }, [result.buffer]);
    }
    const result = type === 'ensure' ? await g.get('ensure')(params) : g.get('run')(name, params);
    postMessage({ id, result });
  } catch (e) {
    postMessage({ id, error: String(e?.message || e) });
  }
};
