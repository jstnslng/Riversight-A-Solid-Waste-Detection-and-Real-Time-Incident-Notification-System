FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && python -c "import cv2, numpy, requests, dotenv, waitress" \
    && useradd --uid 10001 --create-home bridge
COPY segmentation_feed.py production_server.py one_frame.py live_capture.py \
    visual_tracking.py evidence_renderer.py prediction_geometry.py ./
USER 10001:10001
EXPOSE 5001
# Bind is explicitly configured by the runtime, never via secret build args.
CMD ["python", "-B", "production_server.py"]
