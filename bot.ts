// ============== HTTP SERVER FOR AMVERA ==============

async function startHttpServer(port: number) {
  const server = Bun.serve({
    port: port,
    fetch(req) {
      const url = new URL(req.url);
      
      if (url.pathname === '/health' || url.pathname === '/') {
        return new Response(JSON.stringify({ 
          status: 'ok', 
          bot: 'FeldsherRyadomBot for MAX',
          time: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      return new Response('Not found', { status: 404 });
    },
  });
  
  log('INFO', `HTTP server started on port ${port}`);
  console.log(`🌐 HTTP server listening on port ${port}`);
  
  return server;
}

// ============== START ==============

async function main() {
  // ... database connection ...
  
  // Start HTTP server for Amvera health checks
  await startHttpServer(BOT_CONFIG.port);
  
  // Set bot commands
  try {
    await bot.api.setMyCommands([...]);
  } catch (error) {}
  
  // Start bot with polling
  bot.start();
}
