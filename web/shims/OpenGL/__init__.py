"""A stand-in for PyOpenGL that records what lab 6 draws.

The browser has no desktop OpenGL, so OpenGL.GL and OpenGL.GLUT here implement
the fixed-function calls the lab makes (matrix stacks, display lists, immediate
mode quad strips, materials, one light) in Python. Display lists become
triangle buffers and each glutSwapBuffers closes a frame of draw calls with
their model-view matrices. The page renders those with WebGL, applying the
same OpenGL 1.x lighting model. bearing.py and hollow_cylinder.py run unchanged.
"""
