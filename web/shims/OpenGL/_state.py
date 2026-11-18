# Shared state of the OpenGL/GLUT stand-in (see OpenGL/__init__.py).
import math
import numpy as np


def identity(): return np.identity(4)


class State:
  def __init__(self): self.reset()

  def reset(self):
    self.mode = 'modelview'
    self.stacks = dict(modelview=[identity()], projection=[identity()])
    self.enabled = set()
    self.clear_color = [0.0, 0.0, 0.0, 0.0]
    self.light = [0.0, 0.0, 1.0, 0.0]     # GL_LIGHT0 default position, eye space
    self.normal = [0.0, 0.0, 1.0]
    self.material = [0.8, 0.8, 0.8, 1.0]  # default GL_DIFFUSE
    self.shade = 'smooth'
    self.viewport = [0, 0, 0, 0]
    self.lists = {}                       # id -> dict(pos, nrm, col)
    self.next_list = 1
    self.compiling = None
    self.prim = None                      # (mode, [(pos, normal, color), ...], shade)
    self.draws = []                       # current frame: [(list id, modelview)]
    self.frames = 0
    self.redisplay = False
    self.window = dict(title='', width=300, height=300)
    self.display_func = None
    self.reshape_func = None
    self.idle_func = None
    self.calls = {}                       # call counts, shown on the page

  def count(self, name): self.calls[name] = self.calls.get(name, 0) + 1

  @property
  def top(self): return self.stacks[self.mode][-1]

  def mult(self, m): self.stacks[self.mode][-1] = self.top @ m

  # quad strips and friends -> triangles, keeping GL's winding (front faces CCW)
  def flush_prim(self):
    mode, verts, shade = self.prim
    self.prim = None
    tris = []
    if mode == 'quad_strip':
      for i in range(0, len(verts) - 3, 2):
        v0, v1, v2, v3 = verts[i:i + 4]
        prov = v3  # GL_FLAT takes the colour/normal of the quad's last vertex
        quad = [(v0, v1, v2), (v2, v1, v3)]
        for t in quad: tris.append(t if shade == 'smooth' else tuple((v[0], prov[1], prov[2]) for v in t))
    elif mode == 'triangles':
      tris = [tuple(verts[i:i + 3]) for i in range(0, len(verts) - 2, 3)]
    elif mode == 'triangle_strip':
      for i in range(len(verts) - 2):
        tris.append((verts[i], verts[i + 1], verts[i + 2]) if i % 2 == 0 else (verts[i + 1], verts[i], verts[i + 2]))
    elif mode == 'quads':
      for i in range(0, len(verts) - 3, 4):
        v0, v1, v2, v3 = verts[i:i + 4]
        tris += [(v0, v1, v2), (v0, v2, v3)]
    elif mode in ('polygon', 'triangle_fan'):
      for i in range(1, len(verts) - 1): tris.append((verts[0], verts[i], verts[i + 1]))
    target = self.lists[self.compiling] if self.compiling is not None else None
    if target is None:
      # immediate mode outside a display list: keep it as an anonymous list
      lid = -(len(self.draws) + 1)
      target = self.lists.setdefault(lid, dict(pos=[], nrm=[], col=[]))
      self.draws.append((lid, self.top.copy()))
    for t in tris:
      for p, n, c in t:
        target['pos'] += p; target['nrm'] += n; target['col'] += c


def rotation(angle, x, y, z):
  n = math.sqrt(x * x + y * y + z * z) or 1.0
  x, y, z = x / n, y / n, z / n
  c, s = math.cos(math.radians(angle)), math.sin(math.radians(angle))
  C = 1 - c
  return np.array([
    [x * x * C + c, x * y * C - z * s, x * z * C + y * s, 0],
    [y * x * C + z * s, y * y * C + c, y * z * C - x * s, 0],
    [x * z * C - y * s, y * z * C + x * s, z * z * C + c, 0],
    [0, 0, 0, 1],
  ])


def translation(x, y, z):
  m = identity()
  m[:3, 3] = [x, y, z]
  return m


def frustum(l, r, b, t, n, f):
  return np.array([
    [2 * n / (r - l), 0, (r + l) / (r - l), 0],
    [0, 2 * n / (t - b), (t + b) / (t - b), 0],
    [0, 0, -(f + n) / (f - n), -2 * f * n / (f - n)],
    [0, 0, -1, 0],
  ])


def ortho(l, r, b, t, n, f):
  return np.array([
    [2 / (r - l), 0, 0, -(r + l) / (r - l)],
    [0, 2 / (t - b), 0, -(t + b) / (t - b)],
    [0, 0, -2 / (f - n), -(f + n) / (f - n)],
    [0, 0, 0, 1],
  ])


state = State()
