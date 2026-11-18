"""Browser-side glue for the GitHub Pages showcase.

Graphics labs (1-5, control-task) run their own main.py top to bottom with
`__name__ == '__main__'`. Two stand-ins make that possible in the browser:
shims/tkinter.py records what the lab's unchanged graphics.py draws, and a
patched `time` module turns time.sleep into virtual time so the page can
replay the animation. Lab 6 runs the same way against shims/OpenGL, and the
page calls its GLUT display callback once per animation frame.

Parameters typed on the page replace the matching assignments or keyword
arguments in the parsed source (the files are never changed).

The OpenCV labs (7, 8) load their functions with the matplotlib imports and
the plotting entry point left out, and the page draws the images and
histograms the lab would show with plt.
"""
import ast
import base64
import contextlib
import io
import json
import math
import os
import sys
import types
import time as real_time
from time import perf_counter

import numpy as np

HERE = os.getcwd()
LABS_DIR = os.path.join(HERE, 'labs')
SHIMS_DIR = os.path.join(HERE, 'shims')
sys.path.insert(0, SHIMS_DIR)

import tkinter as tk_shim  # noqa: E402  (shims/tkinter.py, there's no Tk in Pyodide)
from OpenGL import _state as gl_state  # noqa: E402

_LAB_MODULES = set()  # module names imported from a lab folder, dropped before the next run


# ------------------------------------------------------------- overrides --
class Overrides(ast.NodeTransformer):
  """Replace `NAME = ...` (matched by the target's source text, e.g. 'X1, X2')
  and `name=...` keyword arguments with expressions typed on the page."""

  def __init__(self, assign=None, kw=None):
    self.assign = {k: ast.parse(v, mode='eval').body for k, v in (assign or {}).items()}
    self.kw = {k: ast.parse(v, mode='eval').body for k, v in (kw or {}).items()}
    self.used = set()

  def visit_Assign(self, node):
    self.generic_visit(node)
    key = ast.unparse(node.targets[0]) if len(node.targets) == 1 else None
    if key in self.assign:
      node.value = self.assign[key]
      self.used.add(key)
    return node

  def visit_AnnAssign(self, node):
    self.generic_visit(node)
    key = ast.unparse(node.target)
    if key in self.assign and node.value is not None:
      node.value = self.assign[key]
      self.used.add(key)
    return node

  def visit_keyword(self, node):
    self.generic_visit(node)
    if node.arg in self.kw:
      node.value = self.kw[node.arg]
      self.used.add(node.arg)
    return node


def _enter_lab(lab):
  """Make `lab` the only lab on sys.path, with fresh copies of its modules."""
  lab_dir = os.path.join(LABS_DIR, lab)
  for name in list(sys.modules):
    root = name.split('.')[0]
    if root in _LAB_MODULES or root in ('graphics', '__lab_main__'):
      del sys.modules[name]
  sys.path[:] = [p for p in sys.path if not p.startswith(LABS_DIR)]
  sys.path.insert(0, lab_dir)
  for entry in os.listdir(lab_dir):
    if entry.endswith('.py'): _LAB_MODULES.add(entry[:-3])
    elif os.path.isdir(os.path.join(lab_dir, entry)): _LAB_MODULES.add(entry)
  os.chdir(lab_dir)
  return lab_dir


def _virtual_time():
  """A `time` module whose sleep() only advances the recorded clock."""
  fake = types.ModuleType('time')
  for k in dir(real_time):
    if not k.startswith('__'): setattr(fake, k, getattr(real_time, k))
  start = real_time.time()
  fake.sleep = lambda s: tk_shim.clock.__setitem__(0, tk_shim.clock[0] + max(0.0, float(s)))
  fake.time = lambda: start + tk_shim.clock[0]
  return fake


def run_main(lab, assign=None, kw=None, file='main.py'):
  lab_dir = _enter_lab(lab)
  path = os.path.join(lab_dir, file)
  tree = ast.parse(open(path).read(), path)
  ov = Overrides(assign, kw)
  tree = ast.fix_missing_locations(ov.visit(tree))
  unknown = (set(assign or {}) | set(kw or {})) - ov.used
  if unknown: raise ValueError(f'no assignment or keyword {", ".join(sorted(unknown))} in {lab}/{file}')
  tk_shim.reset()
  gl_state.state.reset()
  out = io.StringIO()
  real_mod = sys.modules['time']
  sys.modules['time'] = _virtual_time()
  started = perf_counter()
  try:
    with contextlib.redirect_stdout(out):
      ns = dict(__name__='__main__', __file__=path)
      exec(compile(tree, path, 'exec'), ns)
  finally:
    sys.modules['time'] = real_mod
    os.chdir(HERE)
  return ns, out.getvalue(), perf_counter() - started


# ---------------------------------------------------------- graphics labs --
def _num(v):
  return int(v) if float(v).is_integer() else round(v, 3)


def _pack_window(win):
  """Compact op log: colours go to a table, coordinates are flattened.
  add:  [t, 0, id, kind, fill, outline, width, ...coords]
        kind 5 is graphics.Point's 1x1 rectangle, stored as just x, y
  del:  [t, 1, id]        bg:    [t, 2, colour]
  cfg:  [t, 3, id, {...}] move:  [t, 4, id, dx, dy]
  click:[t, 5]            close: [t, 6]"""
  colors, cidx = [], {}

  def c(v):
    v = str(v)
    if v not in cidx: cidx[v] = len(colors); colors.append(v)
    return cidx[v]

  kinds = ['rect', 'oval', 'line', 'poly', 'text']
  ops, texts = [], {}
  counts = dict(rect=0, oval=0, line=0, poly=0, text=0)
  for op in win['ops']:
    t, name = op[0], op[1]
    if name == 'add':
      _, _, item, kind, coords, shape = op
      counts[kind] += 1
      k = kinds.index(kind)
      if kind == 'rect' and coords[2] - coords[0] == 1 and coords[3] - coords[1] == 1: k, coords = 5, coords[:2]
      ops.append([t, 0, item, k, c(shape['fill']), c(shape['outline']), _num(shape['width']), *(_num(v) for v in coords)])
      if kind == 'text': texts[item] = dict(text=shape['text'], font=shape['font'])
    elif name == 'del': ops.append([t, 1, op[2]])
    elif name == 'bg': ops.append([t, 2, c(op[2])])
    elif name == 'cfg': ops.append([t, 3, op[2], op[3]])
    elif name == 'move': ops.append([t, 4, op[2], _num(op[3]), _num(op[4])])
    elif name == 'click': ops.append([t, 5])
    elif name == 'close': ops.append([t, 6])
  return dict(title=win['title'], width=win['width'], height=win['height'], colors=colors, ops=ops, texts=texts,
              counts=counts, duration=max((o[0] for o in ops), default=0))


def graphics(lab, assign=None, kw=None):
  ns, stdout, elapsed = run_main(lab, assign, kw)
  windows = [_pack_window(w.export()) for w in tk_shim.windows]
  return dict(windows=windows, stdout=stdout, ms=round(elapsed * 1000, 1))


# ------------------------------------------------------------ OpenGL lab --
def _mat(m): return [round(float(v), 6) for v in np.asarray(m).T.flatten()]  # column-major for WebGL


def gl_start(assign=None, kw=None):
  ns, stdout, elapsed = run_main('6-lab', assign, kw)
  s = gl_state.state
  lists = {str(k): dict(pos=[round(v, 5) for v in g['pos']], nrm=[round(v, 5) for v in g['nrm']], col=g['col'])
           for k, g in s.lists.items()}
  calls = dict(s.calls)
  return dict(window=s.window, lists=lists, light=s.light, clear=s.clear_color, enabled=sorted(s.enabled),
              calls=calls, stdout=stdout, ms=round(elapsed * 1000, 1),
              triangles={k: len(g['pos']) // 9 for k, g in lists.items()})


def gl_reshape(w, h):
  s = gl_state.state
  if s.reshape_func: s.reshape_func(int(w), int(h))
  return dict(viewport=s.viewport)


def gl_frame():
  s = gl_state.state
  if not s.display_func: raise RuntimeError('glutDisplayFunc was never called')
  s.display_func()
  return dict(draws=[[lid, _mat(mv)] for lid, mv in s.draws], proj=_mat(s.stacks['projection'][-1]),
              clear=s.clear_color, light=s.light, enabled=sorted(s.enabled), viewport=s.viewport,
              frame=s.frames, redisplay=s.redisplay)


# ------------------------------------------------------------ OpenCV labs --
def load_lab(lab, file='main.py', assign=None):
  """The reference loader: keep imports (minus matplotlib), functions, classes
  and module-level assignments; drop the `if __name__ == '__main__'` block."""
  lab_dir = _enter_lab(lab)
  path = os.path.join(lab_dir, file)
  tree = ast.parse(open(path).read(), path)
  keep = []
  for node in tree.body:
    match node:
      case ast.Import() | ast.ImportFrom():
        names = [getattr(node, 'module', None) or ''] + [a.name for a in node.names]
        if not any(n.startswith('matplotlib') for n in names): keep.append(node)
      case ast.FunctionDef() | ast.ClassDef() | ast.Assign():
        keep.append(node)
  mod = ast.fix_missing_locations(Overrides(assign).visit(ast.Module(keep, type_ignores=[])))
  ns = dict(__name__=path)
  try:
    exec(compile(mod, path, 'exec'), ns)
  finally:
    os.chdir(HERE)
  return ns, lab_dir


def _b64(data): return base64.b64encode(bytes(data)).decode()


def _encode(img, fmt='.png'):
  import cv2
  ok, buf = cv2.imencode(fmt, img, [cv2.IMWRITE_JPEG_QUALITY, 92] if fmt == '.jpg' else [])
  if not ok: raise RuntimeError('image encoding failed')
  return _b64(buf)


def _hist(img, mask=None):
  import cv2
  chans = 1 if img.ndim == 2 else img.shape[2]
  return [[int(v) for v in cv2.calcHist([img], [c], mask, [256], [0, 256]).flatten()] for c in range(chans)]


def save_upload(lab, name, data_b64):
  """Store an uploaded image in the lab's imgs/ folder so the lab reads it with cv2.imread."""
  ext = os.path.splitext(name)[1].lower() or '.png'
  path = os.path.join(LABS_DIR, lab, 'imgs', f'upload{ext}')
  os.makedirs(os.path.dirname(path), exist_ok=True)
  with open(path, 'wb') as f: f.write(base64.b64decode(data_b64))
  return os.path.relpath(path, os.path.join(LABS_DIR, lab))


def _read(lab_dir, rel):
  import cv2
  img = cv2.imread(os.path.join(lab_dir, rel))
  if img is None: raise ValueError(f"cv2.imread couldn't read {rel}")
  return img


def lab7(image, y0, y1, x0, x1, fp):
  import cv2
  L, lab_dir = load_lab('7-lab', assign=dict(fp=fp))
  img = _read(lab_dir, image or L['IMGNAME'])
  h, w = img.shape[:2]
  # main.py: mask = np.zeros(img.shape[:2], np.uint8); mask[350:550, 300:700] = 1
  mask = np.zeros(img.shape[:2], np.uint8)
  mask[y0:y1, x0:x1] = 1
  t0 = perf_counter()
  masked_img = cv2.bitwise_and(img, img, mask=mask)
  img_stretched = L['stretch_contrast'](img)
  img_norm = cv2.normalize(masked_img, None, 0, 255, cv2.NORM_MINMAX)
  ms = (perf_counter() - t0) * 1000
  panels = []
  for key, title, im, m in (('img', 'Original', img, None), ('masked', 'Masked', masked_img, mask),
                            ('stretched', 'Contrast stretched (LUT)', img_stretched, None), ('norm', 'Masked, normalized (NORM_MINMAX)', img_norm, mask)):
    panels.append(dict(key=key, title=title, image=_encode(im, '.jpg'), hist=_hist(im, m), masked=m is not None))
  # the curve the lab's LUT applies, read back by running it on a 0..255 ramp
  table = L['stretch_contrast'](np.arange(256, dtype=np.uint8).reshape(1, 256)).flatten()
  return dict(width=w, height=h, mask=[int(y0), int(y1), int(x0), int(x1)], mask_px=int(mask.sum()),
              panels=panels, lut=[int(v) for v in table], ms=round(ms, 1), source=image or L['IMGNAME'])


def lab8(images, max_side):
  import cv2
  L, lab_dir = load_lab('8-lab')
  S, _ = load_lab('8-lab', 'segmentation.py')
  out = []
  for rel in images:
    img = _read(lab_dir, rel)
    h0, w0 = img.shape[:2]
    scale = min(1.0, max_side / max(h0, w0)) if max_side else 1.0
    if scale < 1: img = cv2.resize(img, (round(w0 * scale), round(h0 * scale)), interpolation=cv2.INTER_AREA)
    results, times = {}, {}
    for fn in (L['original'], S['otsu'], S['kmeans'], S['robert']):
      t0 = perf_counter()
      results[fn.__name__] = fn(img)
      times[fn.__name__] = round((perf_counter() - t0) * 1000, 1)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # the lab's otsu() drops the threshold cv2 picked; ask cv2 the same question to show it
    thr, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    km = results['kmeans']
    packed = km.reshape(-1, 3).astype(np.uint32) @ np.array([65536, 256, 1], np.uint32)
    keys, counts = np.unique(packed, return_counts=True)
    colors = [((k >> 16) & 255, (k >> 8) & 255, k & 255) for k in keys.tolist()]
    rob = results['robert']
    # plt.imshow(float image, 'gray') scales min..max to black..white; do the same for the PNG
    lo, hi = float(rob.min()), float(rob.max())
    rob_disp = np.uint8(np.clip((rob - lo) / (hi - lo or 1) * 255, 0, 255))
    panels = [
      dict(key='original', image=_encode(cv2.cvtColor(results['original'], cv2.COLOR_RGB2BGR)), hist=_hist(img)),
      dict(key='otsu', image=_encode(results['otsu']), hist=_hist(results['otsu'])),
      dict(key='kmeans', image=_encode(cv2.cvtColor(km, cv2.COLOR_RGB2BGR)), hist=_hist(cv2.cvtColor(km, cv2.COLOR_RGB2GRAY))),
      dict(key='robert', image=_encode(rob_disp), hist=_hist(rob_disp)),
    ]
    out.append(dict(source=rel, width=img.shape[1], height=img.shape[0], orig_width=w0, orig_height=h0,
                    panels=panels, times=times, gray_hist=_hist(gray)[0], otsu=float(thr),
                    centers=[dict(rgb=[int(v) for v in c], pixels=int(n)) for c, n in zip(colors, counts)],
                    robert_range=[round(lo, 3), round(hi, 3)],
                    otsu_white=int((results['otsu'] > 0).sum())))
  return dict(images=out)


RUNNERS = dict(graphics=graphics, gl_start=gl_start, gl_reshape=gl_reshape, gl_frame=gl_frame,
               lab7=lab7, lab8=lab8, save_upload=save_upload)


def put_file(lab, rel, data_b64):
  """Write a repo file fetched by the page (the lab images) at its path in the lab folder."""
  path = os.path.join(LABS_DIR, lab, rel)
  os.makedirs(os.path.dirname(path), exist_ok=True)
  with open(path, 'wb') as f: f.write(base64.b64decode(data_b64))
  return rel


RUNNERS['put_file'] = put_file
