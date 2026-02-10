# ---------- Build stage ----------
FROM node:22 AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build


# ---------- Runtime stage ----------
FROM node:22-slim

WORKDIR /app

# Copy only production deps
COPY package*.json ./
RUN npm install --production

# Copy compiled JS
COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/src/index.js"]