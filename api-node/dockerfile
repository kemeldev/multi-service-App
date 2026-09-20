FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ARG COMMIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV COMMIT_SHA=$COMMIT_SHA BUILD_TIME=$BUILD_TIME
USER node
EXPOSE 8002
CMD ["npm", "start"]
