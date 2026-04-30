FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 10000

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

ENV SHOPIFY_APP_URL=https://ollama-seo-agent.onrender.com
ENV NODE_ENV=production

RUN npm run build

CMD ["npm", "run", "docker-start"]
