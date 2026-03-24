FROM oven/bun:1

WORKDIR /app

COPY package.json ./
COPY prisma ./prisma/

RUN bun install
RUN bunx prisma generate

RUN mkdir -p /app/data && chmod 777 /app/data

COPY bot.ts ./

CMD ["bun", "run", "bot.ts"]
