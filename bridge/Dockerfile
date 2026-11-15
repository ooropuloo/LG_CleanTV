# Build from tv-home/:  docker build -f bridge/Dockerfile -t tv-home .
FROM python:3.12-slim
LABEL tv-home=1
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY bridge/requirements.txt /app/bridge/requirements.txt
RUN pip install --no-cache-dir -r /app/bridge/requirements.txt
COPY bridge/ /app/bridge/
COPY web/ /app/web/
COPY cats/ /app/cats/
COPY vendor/ /app/vendor/
RUN rm -f /app/bridge/.env
EXPOSE 8790
CMD ["python", "/app/bridge/server.py"]
