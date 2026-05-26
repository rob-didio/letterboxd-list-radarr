FROM python:3.12-slim

WORKDIR /app

# curl_cffi ships a manylinux wheel with curl-impersonate inside, so no system-level
# OpenSSL/curl install is needed. lxml ships a wheel too.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
RUN pip install --no-cache-dir .

COPY app.py ./

EXPOSE 5001
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5001"]
