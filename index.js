import dotenv from 'dotenv';
import { createApp } from './app.js';

dotenv.config();

const PORT = process.env.PORT || 3000;
const app = createApp();

app.listen(PORT, () => {
  console.log(`Payment server running on port ${PORT}`);
  console.log('Ready to process activation payments');
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
