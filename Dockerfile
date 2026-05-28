ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /app

COPY package*.json .npmrc* ./
RUN npm config set registry "${NPM_REGISTRY}" \
 && npm ci --omit=dev --no-fund --no-audit --registry="${NPM_REGISTRY}"

COPY . .
RUN mkdir -p /app/uploads

EXPOSE 3000

CMD ["npm", "run", "start"]
