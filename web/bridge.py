# PyScript entry: exposes the labs to the page's JavaScript.
import json
from pyscript import window
from pyodide.ffi import create_proxy
import pyodide_js
import showcase


def run(name: str, params: str) -> str:
  try:
    return json.dumps(dict(ok=True, data=showcase.RUNNERS[str(name)](**json.loads(str(params)))))
  except Exception as e:  # surface failures in the UI instead of hanging it
    return json.dumps(dict(ok=False, error=f'{type(e).__name__}: {e}'))


async def ensure(packages: str):
  # OpenCV (about 11 MB) and SciPy (about 14 MB) are only fetched when lab 7 or 8 opens
  await pyodide_js.loadPackage(json.loads(str(packages)))


window.pyRun = create_proxy(run)
window.pyEnsure = create_proxy(ensure)
window.dispatchEvent(window.CustomEvent.new('py-ready'))
