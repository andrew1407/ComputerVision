# OpenGL.GL stand-in: the fixed-function subset lab 6 uses (see OpenGL/__init__.py).
from ._state import state as _s, rotation as _rot, translation as _tr, frustum as _fr, ortho as _or, identity as _id

GL_COLOR_BUFFER_BIT = 0x4000
GL_DEPTH_BUFFER_BIT = 0x0100
GL_MODELVIEW = 0x1700
GL_PROJECTION = 0x1701
GL_COMPILE = 0x1300
GL_COMPILE_AND_EXECUTE = 0x1301
GL_CULL_FACE = 0x0B44
GL_LIGHTING = 0x0B50
GL_LIGHT0 = 0x4000
GL_DEPTH_TEST = 0x0B71
GL_NORMALIZE = 0x0BA1
GL_POSITION = 0x1203
GL_FRONT = 0x0404
GL_BACK = 0x0405
GL_FRONT_AND_BACK = 0x0408
GL_AMBIENT = 0x1200
GL_DIFFUSE = 0x1201
GL_AMBIENT_AND_DIFFUSE = 0x1602
GL_FLAT = 0x1D00
GL_SMOOTH = 0x1D01
GL_QUAD_STRIP = 0x0008
GL_QUADS = 0x0007
GL_TRIANGLES = 0x0004
GL_TRIANGLE_STRIP = 0x0005
GL_TRIANGLE_FAN = 0x0006
GL_POLYGON = 0x0009

_PRIMS = {GL_QUAD_STRIP: 'quad_strip', GL_QUADS: 'quads', GL_TRIANGLES: 'triangles',
          GL_TRIANGLE_STRIP: 'triangle_strip', GL_TRIANGLE_FAN: 'triangle_fan', GL_POLYGON: 'polygon'}
_CAPS = {GL_CULL_FACE: 'cull_face', GL_LIGHTING: 'lighting', GL_LIGHT0: 'light0', GL_DEPTH_TEST: 'depth_test', GL_NORMALIZE: 'normalize'}


def glClearColor(r, g, b, a): _s.count('glClearColor'); _s.clear_color = [float(r), float(g), float(b), float(a)]
def glClear(mask): _s.count('glClear'); _s.draws = []
def glEnable(cap): _s.count('glEnable'); _s.enabled.add(_CAPS.get(cap, cap))
def glDisable(cap): _s.count('glDisable'); _s.enabled.discard(_CAPS.get(cap, cap))
def glViewport(x, y, w, h): _s.count('glViewport'); _s.viewport = [int(x), int(y), int(w), int(h)]
def glShadeModel(mode): _s.count('glShadeModel'); _s.shade = 'flat' if mode == GL_FLAT else 'smooth'


def glMatrixMode(mode): _s.count('glMatrixMode'); _s.mode = 'projection' if mode == GL_PROJECTION else 'modelview'
def glLoadIdentity(): _s.count('glLoadIdentity'); _s.stacks[_s.mode][-1] = _id()
def glPushMatrix(): _s.count('glPushMatrix'); _s.stacks[_s.mode].append(_s.top.copy())
def glPopMatrix(): _s.count('glPopMatrix'); _s.stacks[_s.mode].pop()
def glTranslatef(x, y, z): _s.count('glTranslatef'); _s.mult(_tr(x, y, z))
def glRotatef(angle, x, y, z): _s.count('glRotatef'); _s.mult(_rot(angle, x, y, z))
def glFrustum(l, r, b, t, n, f): _s.count('glFrustum'); _s.mult(_fr(l, r, b, t, n, f))
def glOrtho(l, r, b, t, n, f): _s.count('glOrtho'); _s.mult(_or(l, r, b, t, n, f))
glTranslated, glRotated = glTranslatef, glRotatef


def glLightfv(light, pname, params):
  _s.count('glLightfv')
  if light == GL_LIGHT0 and pname == GL_POSITION:
    p = [float(v) for v in params]
    # the position is stored in eye coordinates: transformed by the current model-view
    _s.light = list((_s.stacks['modelview'][-1] @ p).tolist())


def glMaterialfv(face, pname, params):
  _s.count('glMaterialfv')
  if pname in (GL_AMBIENT_AND_DIFFUSE, GL_DIFFUSE): _s.material = [float(v) for v in params]


def glNormal3f(x, y, z): _s.count('glNormal3f'); _s.normal = [float(x), float(y), float(z)]
glNormal3d = glNormal3f


def glBegin(mode): _s.count('glBegin'); _s.prim = (_PRIMS[mode], [], _s.shade)


def glVertex3f(x, y, z):
  _s.count('glVertex3f')
  _s.prim[1].append(([float(x), float(y), float(z)], list(_s.normal), list(_s.material)))
glVertex3d = glVertex3f


def glEnd(): _s.count('glEnd'); _s.flush_prim()


def glGenLists(n):
  _s.count('glGenLists')
  first = _s.next_list
  _s.next_list += n
  return first


def glNewList(lid, mode):
  _s.count('glNewList')
  _s.lists[lid] = dict(pos=[], nrm=[], col=[])
  _s.compiling = lid


def glEndList(): _s.count('glEndList'); _s.compiling = None
def glCallList(lid): _s.count('glCallList'); _s.draws.append((lid, _s.top.copy()))
def glFlush(): pass
