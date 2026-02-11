const { createApp } = require('./app');

// Load environment variables
require('dotenv').config();

// Start the server
const app = createApp();
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 SwiftWallet Payment Server running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log('✅ SwiftWallet integration complete - PayHero compatible responses');
});

// ✅ Self-message scheduler (runs every 10 minutes)
function sendSelfMessage() {
  console.log("⏳ Sending scheduled self-message...");

  fetch(`http://localhost:${PORT}/internal/ping`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timestamp: new Date().toISOString() })
  })
    .then(res => res.text())
    .then(msg => console.log("✅ Self-message response:", msg))
    .catch(err => console.error("❌ Self-message error:", err));
}

// Run immediately on startup
sendSelfMessage();

// Run every 10 minutes
setInterval(sendSelfMessage, 10 * 60 * 1000);
