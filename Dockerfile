FROM node:24.19.0-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.11 python3.11-venv python3-pip build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY requirements.txt ./
RUN python3.11 -m venv .venv && .venv/bin/pip install --no-cache-dir -r requirements.txt

COPY tsconfig.json ./
COPY src ./src
COPY eval ./eval
COPY tests ./tests
COPY examples ./examples
COPY reference ./reference

RUN npx tsc --noEmit

CMD ["npm", "run", "all"]
