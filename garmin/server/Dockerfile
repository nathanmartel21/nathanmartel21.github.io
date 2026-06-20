# Container for the stateless Garmin proxy.
# Works as-is on Hugging Face Spaces (SDK: docker) and on Render.
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY garmin_pull.py app.py ./

# Hugging Face Spaces inject $PORT (defaults to 7860); Render uses $PORT too.
ENV PORT=7860
EXPOSE 7860

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-7860}"]
