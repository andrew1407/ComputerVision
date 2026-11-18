"""A stand-in for tkinter that records what graphics.py draws.

The labs (1-5, control-task) draw through John Zelle's graphics.py, which is a
thin layer over tkinter.Canvas. The browser has no Tk, so this module provides
the small part of tkinter that graphics.py uses and logs every canvas call
(create, delete, itemconfig, move, background change) with a virtual time
stamp. The page replays that log on an HTML canvas. graphics.py and the labs
run unchanged.
"""
import itertools

windows = []           # every Canvas created during a run, in order
clock = [0.0]          # virtual seconds, advanced by the patched time.sleep
_ids = itertools.count(1)


def reset():
  windows.clear()
  clock[0] = 0.0


class TclError(Exception):
  pass


class Misc:
  def update(self): pass
  def update_idletasks(self): pass
  def after(self, ms, func=None, *args):
    if func: func(*args)


class Tk(Misc):
  def withdraw(self): pass
  def mainloop(self, n=0): pass
  def destroy(self): pass


class Toplevel(Misc):
  def __init__(self, master=None, **kw):
    self.master = master
    self._title = ''
    self.canvas = None

  def protocol(self, name, func): pass
  def resizable(self, *a): pass
  def lift(self): pass

  def title(self, text=None):
    if text is None: return self._title
    self._title = text
    if self.canvas: self.canvas._title = text

  def destroy(self):
    if self.canvas: self.canvas._log('close')


def _opt(options, kw):
  merged = dict(options or {})
  merged.update(kw)
  return merged


class Canvas(Misc):
  def __init__(self, master=None, width=200, height=200, **kw):
    self.master = master
    if isinstance(master, Toplevel): master.canvas = self
    self._title = getattr(master, '_title', '')
    self._w, self._h = int(width), int(height)
    self._bg = '#d9d9d9'  # Tk's default canvas background
    self._ops = []        # [t, op, ...]
    self._handlers = {}
    self._t0 = clock[0]   # each window's log starts at its own t = 0
    windows.append(self)

  # -- recording
  def _log(self, *op):
    self._ops.append([round(clock[0] - self._t0, 4), *op])

  def _create(self, kind, coords, options, kw):
    o = _opt(options, kw)
    item = next(_ids)
    flat = []
    for c in coords:
      if isinstance(c, (tuple, list)): flat.extend(float(v) for v in c)
      else: flat.append(float(c))
    shape = dict(fill=o.get('fill', ''), outline=o.get('outline', 'black'), width=float(o.get('width', 1) or 1))
    if kind == 'line': shape['outline'] = o.get('fill', 'black'); shape['fill'] = ''; shape['arrow'] = o.get('arrow', 'none')
    if kind == 'text':
      shape['fill'] = o.get('fill', 'black'); shape['text'] = str(o.get('text', ''))
      f = o.get('font', ('helvetica', 12, 'normal'))
      shape['font'] = list(f) if isinstance(f, (tuple, list)) else [str(f), 12, 'normal']
    self._log('add', item, kind, flat, shape)
    return item

  def create_rectangle(self, *coords, **kw):
    options = coords[-1] if coords and isinstance(coords[-1], dict) else None
    return self._create('rect', coords[:-1] if options is not None else coords, options, kw)

  def create_oval(self, *coords, **kw):
    options = coords[-1] if coords and isinstance(coords[-1], dict) else None
    return self._create('oval', coords[:-1] if options is not None else coords, options, kw)

  def create_line(self, *coords, **kw):
    options = coords[-1] if coords and isinstance(coords[-1], dict) else None
    return self._create('line', coords[:-1] if options is not None else coords, options, kw)

  def create_polygon(self, *coords, **kw):
    options = coords[-1] if coords and isinstance(coords[-1], dict) else None
    return self._create('poly', coords[:-1] if options is not None else coords, options, kw)

  def create_text(self, *coords, **kw):
    options = coords[-1] if coords and isinstance(coords[-1], dict) else None
    return self._create('text', coords[:-1] if options is not None else coords, options, kw)

  def create_image(self, *coords, **kw):
    return next(_ids)  # Image objects are not used by the labs

  def delete(self, item):
    self._log('del', item)

  def itemconfig(self, item, options=None, **kw):
    o = _opt(options, kw)
    self._log('cfg', item, {k: (list(v) if isinstance(v, tuple) else v) for k, v in o.items()})

  itemconfigure = itemconfig

  def move(self, item, dx, dy):
    self._log('move', item, float(dx), float(dy))

  def config(self, **kw):
    if 'bg' in kw:
      self._bg = kw['bg']
      self._log('bg', kw['bg'])

  configure = config

  def pack(self, *a, **kw): pass
  def bind(self, seq, func, add=None): self._handlers[seq] = func
  def bind_all(self, seq, func, add=None): self._handlers[seq] = func

  def update(self):
    # graphics.GraphWin.getMouse() spins on update() until a click arrives.
    # The browser can't block, so a click "arrives" at once and the page
    # shows where the lab waited for it.
    handler = self._handlers.get('<Button-1>')
    if handler:
      class Event: pass
      e = Event(); e.x = self._w // 2; e.y = self._h // 2
      if not self._ops or self._ops[-1][1] != 'click': self._log('click')
      handler(e)

  def export(self):
    return dict(title=self._title, width=self._w, height=self._h, ops=self._ops)


class StringVar:
  def __init__(self, master=None, value=''): self._v = value
  def get(self): return self._v
  def set(self, v): self._v = v


class Frame(Misc):
  def __init__(self, *a, **kw): pass
  def pack(self, *a, **kw): pass


class Entry(Misc):
  def __init__(self, *a, **kw): pass
  def pack(self, *a, **kw): pass


class PhotoImage:
  def __init__(self, *a, **kw): pass
