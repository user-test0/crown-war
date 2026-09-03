# Hugging Face Spaces 用 Dockerfile（HF 要求 Dockerfile 在仓库根目录）
# HF 会自动注入 PORT 环境变量（默认 7860），服务器已支持读取 PORT
FROM node:20-alpine
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY server/server.js ./
EXPOSE 7860
CMD ["node", "server.js"]
