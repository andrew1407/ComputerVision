# PyScript worker entry: runs the labs off the page's main thread.
# The page calls the exported functions with JSON in and JSON out (no DOM
# access from here), so this works without SharedArrayBuffer on GitHub Pages.
import json
import pyodide_js
from polyscript import xworker
import showcase


def run(name, params):
  try:
    return json.dumps(dict(ok=True, data=showcase.RUNNERS[str(name)](**json.loads(str(params)))))
  except Exception as e:  # surface failures in the UI instead of hanging it
    return json.dumps(dict(ok=False, error=f'{type(e).__name__}: {e}'))


async def ensure(packages):
  # OpenCV (about 11 MB) and SciPy (about 14 MB) are only fetched when lab 7 or 8 opens
  await pyodide_js.loadPackage(json.loads(str(packages)))


xworker.sync.run = run
xworker.sync.ensure = ensure
