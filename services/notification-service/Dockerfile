FROM python:3.11-slim
WORKDIR /app
RUN useradd -m appuser && chown -R appuser:appuser /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN chown -R appuser:appuser /app
USER appuser
EXPOSE 3004
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:3004/health')" || exit 1
CMD ["python", "app.py"]
