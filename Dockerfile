FROM node:20-alpine

# Install bun
RUN apk add --no-cache curl && \
    curl -fsSL https://bun.sh/install | sh && \
    apk del curl

ENV PATH="/root/.bun/bin:$PATH"

WORKDIR /app

# Copy files
COPY package.json ./
COPY prisma ./prisma/

# Install and generate
RUN bun install && bunx prisma generate

# Create data dir
RUN mkdir -p /app/data

# Copy bot
COPY bot.ts ./

# Expose port
EXPOSE 8080

# Start command
CMD ["sh", "-c", "mkdir -p /app/data && bunx prisma db push --skip-generate && bun bot.ts"]
