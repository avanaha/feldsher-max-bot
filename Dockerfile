FROM oven/bun:1

WORKDIR /app

# Copy package files
COPY package.json ./
COPY prisma ./prisma/

# Install dependencies
RUN bun install

# Generate Prisma client
RUN bunx prisma generate

# Create data directory
RUN mkdir -p /app/data && chmod 777 /app/data

# Copy bot
COPY bot.ts ./

# Start bot directly (tables will be created by bot)
CMD ["bun", "run", "bot.ts"]
