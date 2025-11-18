# Payment Server Setup

This server handles PayHero payment integration for account activation.

## Installation

1. Navigate to the server directory:
```bash
cd server
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file based on `.env.example`:
```bash
cp .env.example .env
```

4. Fill in your PayHero credentials and Supabase details in `.env`:
```env
PORT=3000
PAYHERO_USERNAME=your_payhero_username
PAYHERO_API_PASSWORD=your_payhero_api_password
PAYHERO_CHANNEL_ID=your_channel_id
CALLBACK_URL=http://localhost:3000/api/callback
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_KEY=your_supabase_service_role_key
```

## Running the Server

Development mode:
```bash
npm run dev
```

Production mode:
```bash
npm start
```

The server will run on port 3000 (or the PORT specified in .env).

## API Endpoints

### POST /api/pay
Initiates a payment request to PayHero.

**Request Body:**
```json
{
  "phone": "0712345678",
  "amount": 500,
  "reference": "ACTIVATION_xxx_timestamp"
}
```

**Response:**
```json
{
  "status": "QUEUED",
  "message": "STK Push initiated.",
  "checkoutRequestID": "ws_CO_xxx",
  "external_reference": "ACTIVATION_xxx_timestamp"
}
```

### POST /api/callback
Receives payment status updates from PayHero.

This endpoint is called automatically by PayHero when payment status changes.

### GET /api/status/:externalRef
Check the status of a payment by its external reference.

**Response:**
```json
{
  "status": "Success",
  "payment_status": {
    "status": "SUCCESS",
    "details": "Payment confirmed"
  }
}
```

## How It Works

1. User clicks "Pay" on the payment page
2. Frontend sends payment request to `/api/pay`
3. Server forwards request to PayHero API
4. PayHero sends STK push to user's phone
5. User enters M-PESA PIN on their phone
6. PayHero sends callback to `/api/callback`
7. Server updates database and activates user account
8. Server distributes referral commissions to uplines
9. Frontend polls for status and redirects to dashboard

## Security Notes

- Never expose your PayHero API password or Supabase service key
- The callback URL should be publicly accessible (use ngrok for local testing)
- All sensitive operations use Supabase service role key
- Payment statuses are verified before activating accounts

## Local Testing with ngrok

For local development, you need to expose your localhost to the internet for PayHero callbacks:

1. Install ngrok: https://ngrok.com/download
2. Start your server: `npm run dev`
3. In another terminal, run: `ngrok http 3000`
4. Copy the ngrok URL (e.g., `https://abc123.ngrok.io`)
5. Update CALLBACK_URL in .env to: `https://abc123.ngrok.io/api/callback`
6. Restart your server

## Deployment

For production deployment:

1. Deploy to a platform that supports Node.js (Heroku, Railway, Render, etc.)
2. Set environment variables in your deployment platform
3. Update CALLBACK_URL to your production domain
4. Ensure your server is accessible publicly for PayHero callbacks

## Troubleshooting

**Payment stuck in QUEUED status:**
- Check if PayHero callback URL is accessible
- Verify your PayHero credentials are correct
- Check server logs for errors

**STK Push not received:**
- Verify phone number format (should start with 254)
- Ensure M-PESA is active on the phone number
- Check PayHero account balance/status

**Database errors:**
- Verify Supabase credentials are correct
- Ensure service role key (not anon key) is being used
- Check database migrations have been applied
