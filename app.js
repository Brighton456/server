import express from 'express';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import cors from 'cors';

const REQUIRED_ENV_VARS = [
  'PAYHERO_USERNAME',
  'PAYHERO_API_PASSWORD',
  'PAYHERO_CHANNEL_ID',
  'CALLBACK_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
];

const createApp = () => {
  const app = express();

  // Configure CORS to allow your Netlify frontend
  app.use(cors({
    origin: [
      'http://localhost:3000',  // Local development
      'http://localhost:8081',  // Expo local
      'https://gig-smart.netlify.app'  // Your production frontend
    ],
    credentials: true
  }));
  
  app.use(express.json());
  app.use(express.static('public'));

  const PAYHERO_API = 'https://backend.payhero.co.ke/api/v2/payments';

  const missingEnv = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missingEnv.length) {
    console.warn(`⚠️ Missing environment variables: ${missingEnv.join(', ')}`);
  }

  const authString = `${process.env.PAYHERO_USERNAME || ''}:${process.env.PAYHERO_API_PASSWORD || ''}`;
  const PAYHERO_BASIC_AUTH = 'Basic ' + Buffer.from(authString).toString('base64');

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const transactionStatuses = new Map();

  app.post('/api/pay', async (req, res) => {
    let { phone, amount, reference } = req.body;

    amount = Number(amount);

    const fullPhone = phone.startsWith('254') ? phone : `254${phone}`;

    const payload = {
      channel_id: process.env.PAYHERO_CHANNEL_ID,
      amount,
      phone_number: fullPhone,
      external_reference: reference,
      callback_url: process.env.CALLBACK_URL,
      provider: 'm-pesa'
    };

    try {
      const response = await axios.post(PAYHERO_API, payload, {
        headers: {
          Authorization: PAYHERO_BASIC_AUTH,
          'Content-Type': 'application/json'
        }
      });

      const data = response.data;

      const statusKey = data?.external_reference || reference;

      if (statusKey) {
        transactionStatuses.set(statusKey, {
          status: (data.status || 'QUEUED').toUpperCase(),
          details: data.message || 'STK Push initiated, waiting for user confirmation.',
          checkoutRequestID: data.CheckoutRequestID || null,
          lastUpdated: new Date().toISOString()
        });
      }

      res.json({
        status: data.status || 'QUEUED',
        message: data.message || 'STK Push initiated.',
        checkoutRequestID: data.CheckoutRequestID || null,
        external_reference: statusKey,
        raw: data
      });
    } catch (error) {
      console.error('Payment initiation error:', error.response?.data || error.message);
      res.status(500).json({
        status: 'Failure',
        message: error.response?.data?.message || error.message || 'Payment failed',
        error: error.response?.data || null
      });
    }
  });

  app.post('/api/callback', async (req, res) => {
    const data = req.body;

    try {
      const statusRaw = data?.response?.Status || data?.status;
      const status = statusRaw ? statusRaw.toUpperCase() : null;
      const externalRef = data?.response?.ExternalReference
        || data?.external_reference
        || data?.response?.external_reference
        || data?.reference;

      if (externalRef) {
        transactionStatuses.set(externalRef, {
          status,
          result_code: data?.response?.ResultCode,
          result_desc: data?.response?.ResultDesc,
          full_callback: data,
          lastUpdated: new Date().toISOString()
        });
      }

      if (externalRef) {
        await supabase
          .from('payment_callbacks')
          .insert([{ external_reference: externalRef, callback_data: data, status }]);
      }

      if (status && status.toLowerCase() === 'success') {
        const { data: paymentData } = await supabase
          .from('activation_payments')
          .update({
            status: 'SUCCESS',
            confirmed_at: new Date().toISOString(),
            payhero_response: data
          })
          .eq('external_reference', externalRef)
          .select('user_id')
          .single();

        if (paymentData) {
          await supabase
            .from('users')
            .update({
              is_activated: true,
              activation_date: new Date().toISOString()
            })
            .eq('id', paymentData.user_id);

          await supabase.rpc('distribute_referral_commissions', {
            new_user_id: paymentData.user_id
          });

          await supabase
            .from('transactions')
            .insert([
              {
                user_id: paymentData.user_id,
                type: 'Activation Payment',
                amount: -500,
                balance_after: 0,
                source: 'PayHero',
                description: 'Account activation fee'
              }
            ]);
        }
      } else if (status && status.toLowerCase() === 'failed') {
        await supabase
          .from('activation_payments')
          .update({
            status: 'FAILED',
            payhero_response: data
          })
          .eq('external_reference', externalRef);
      }
    } catch (err) {
      console.error('Callback processing error:', err.message);
    }

    res.sendStatus(200);
  });

  app.get('/api/status/:externalRef', async (req, res) => {
    const externalRef = req.params.externalRef;
    const statusInfo = transactionStatuses.get(externalRef);

    if (statusInfo) {
      return res.json({ 
        status: 'Success', 
        payment_status: statusInfo,
        timestamp: new Date().toISOString()
      });
    }

    try {
      const { data: callbackRows, error: callbackError } = await supabase
        .from('payment_callbacks')
        .select('status, callback_data, created_at')
        .eq('external_reference', externalRef)
        .order('created_at', { ascending: false })
        .limit(1);

      if (callbackError) {
        throw callbackError;
      }

      if (callbackRows && callbackRows.length > 0) {
        const latest = callbackRows[0];
        const normalizedStatus = (latest.status || 'PENDING').toUpperCase();
        const payload = {
          status: normalizedStatus,
          full_callback: latest.callback_data,
          lastUpdated: latest.created_at
        };

        transactionStatuses.set(externalRef, payload);

        return res.json({
          status: 'Success',
          payment_status: payload,
          timestamp: new Date().toISOString()
        });
      }

      return res.status(202).json({
        status: 'Pending',
        message: 'Payment status not yet available',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Status lookup error:', error.message);
      return res.status(500).json({
        status: 'Failure',
        message: 'Unable to retrieve payment status',
        timestamp: new Date().toISOString()
      });
    }
  });

  app.get('/', (req, res) => {
    res.json({
      status: 'Server is running',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      routes: {
        payment: '/api/pay',
        callback: '/api/callback',
        status: '/api/status/:externalRef',
        health: '/health'
      }
    });
  });

  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development'
    });
  });

  // ✅ Internal route for scheduler
  app.post('/internal/ping', (req, res) => {
    console.log("✅ Self-message received:", req.body);
    res.send("OK");
  });

  return app;
};

const app = createApp();

export default app;
export { createApp };
