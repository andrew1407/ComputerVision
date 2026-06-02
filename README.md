# ComputerVision

A collection of computer-graphics and computer-vision labs in **Python**, progressing
from raster primitives and 3D projections to OpenCV image processing and YOLO object
detection. Real-time rendering is done with OpenGL/GLUT through the shared `graphics`
module; image work uses OpenCV, NumPy and Matplotlib.

## Labs

| Lab | Topic |
|---|---|
| [`1-lab`](1-lab) | Calculation strategies — scalar vs. sequential/composed matrix pipelines |
| [`2-lab`](2-lab) | Spatial transforms — axonometric projection, custom rotation, layered drawing |
| [`3-lab`](3-lab) | Raster algorithms — Bresenham lines, vertical intersection, contour extraction |
| [`4-lab`](4-lab) | Vector graphics — least-squares fitting, painter's algorithm, orthogonal projection |
| [`5-lab`](5-lab) | Fractals — Sierpinski carpet and a recursive fractal tree |
| [`6-lab`](6-lab) | OpenGL/GLUT — interactive 3D bearing model |
| [`7-lab`](7-lab) | OpenCV — image transforms and histograms |
| [`8-lab`](8-lab) | Image segmentation — Otsu thresholding, k-means, Roberts cross |
| [`9-lab`](9-lab) | Object detection — YOLOv3 on highway-traffic video (OpenCV DNN) |
| [`control-task`](control-task) | 3D face model with plane-normal back-face culling |

## Stack

- **Python** with **NumPy** and `math` for the geometry
- **PyOpenGL** (GLUT) for real-time rendering via the local `graphics` module
- **OpenCV** (`cv2`) and **Matplotlib** for image processing and visualization

## Run

Each lab is self-contained — run its `main.py` from inside the lab directory:

```bash
cd 8-lab
python main.py
```

Dependencies: `pip install numpy opencv-python matplotlib PyOpenGL PyOpenGL_accelerate`.
Lab 9 additionally needs the YOLOv3 weights/config placed under `9-lab/model/`.
