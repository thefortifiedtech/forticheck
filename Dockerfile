# Use Node.js 22-slim as the base image
FROM node:22-slim

# Install Python 3, build tools, and sqlite3
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    build-essential \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Set up working directory
WORKDIR /app

# Install Node.js package dependencies
COPY package*.json tsconfig.json ./
RUN npm ci --legacy-peer-deps

# Install Python dependencies (requests)
RUN pip3 install --no-cache-dir requests --break-system-packages

# Copy the rest of the application files
COPY . .

# Build TypeScript source code
RUN npm run build

# Copy static files to dist directory for web server
COPY src/web/static dist/web/static

# Expose web dashboard port
EXPOSE 3001

# Default start command (can be overridden in docker-compose)
CMD ["node", "dist/index.js"]
