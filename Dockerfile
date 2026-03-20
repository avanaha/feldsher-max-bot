FROM oven/bun:1

WORKDIR /app

# Copy package files first
COPY package.json ./
COPY prisma ./prisma/

# Install dependencies
RUN bun install

# Generate Prisma client
RUN bunx prisma generate

# Create data directory with proper permissions
RUN mkdir -p /app/data && chmod 777 /app/data

# Copy bot
COPY bot.ts ./

# Create startup script
RUN echo '#!/bin/sh' > /app/start.sh && \
    echo 'echo "Creating data directory..."' >> /app/start.sh && \
    echo 'mkdir -p /app/data' >> /app/start.sh && \
    echo 'echo "Initializing database..."' >> /app/start.sh && \
    echo 'bunx prisma db push --skip-generate' >> /app/start.sh && \
    echo 'echo "Starting bot..."' >> /app/start.sh && \
    echo 'bun run bot.ts' >> /app/start.sh && \
    chmod +x /app/start.sh

# Start
CMD ["/app/start.sh"]
