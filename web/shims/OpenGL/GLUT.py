# OpenGL.GLUT stand-in: window setup and callbacks (see OpenGL/__init__.py).
# glutMainLoop returns at once; the page drives the display callback from
# requestAnimationFrame instead.
from ._state import state as _s

GLUT_RGB = 0
GLUT_RGBA = 0
GLUT_DOUBLE = 2
GLUT_DEPTH = 16


def glutInit(*args): _s.count('glutInit')
def glutInitDisplayMode(mode): _s.count('glutInitDisplayMode')
def glutInitWindowSize(w, h): _s.count('glutInitWindowSize'); _s.window.update(width=int(w), height=int(h))
def glutInitWindowPosition(x, y): _s.count('glutInitWindowPosition')


def glutCreateWindow(title):
  _s.count('glutCreateWindow')
  _s.window['title'] = title.decode() if isinstance(title, bytes) else str(title)
  return 1


def glutDisplayFunc(f): _s.count('glutDisplayFunc'); _s.display_func = f
def glutReshapeFunc(f): _s.count('glutReshapeFunc'); _s.reshape_func = f
def glutIdleFunc(f): _s.count('glutIdleFunc'); _s.idle_func = f
def glutPostRedisplay(): _s.count('glutPostRedisplay'); _s.redisplay = True
def glutSwapBuffers(): _s.count('glutSwapBuffers'); _s.frames += 1
def glutMainLoop(): _s.count('glutMainLoop')
