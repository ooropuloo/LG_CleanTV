# tv-home scene factory image (runs on the HA host, aarch64). Build context = tv-home/factory:
#   sudo docker build -t tvhome-factory /opt/tv-home/factory
# Code is NOT copied in: run.sh mounts factory/ and cats/live/ read-only, so editing a .py needs no rebuild.
FROM python:3.12-slim
LABEL tvhome-factory=1
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=2 OMP_NUM_THREADS=2
RUN pip install --no-cache-dir numpy==2.2.6 scipy==1.15.3 opencv-python-headless==4.11.0.86 \
 && python -c "import numpy, scipy, cv2; print(numpy.__version__, scipy.__version__, cv2.__version__)"
WORKDIR /factory
