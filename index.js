const { createApp } = require('./app');

// Start the server
const app = createApp();
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 SwiftWallet Payment Server running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log('✅ SwiftWallet integration complete - PayHero compatible responses');
});
