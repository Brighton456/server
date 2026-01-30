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

  // Helper function to create transaction directly
  async function createDirectTransaction(externalRef, callbackData, userId = null) {
    try {
      console.log('🔄 Creating direct transaction for:', externalRef);
      
      // Extract amount from callback data
      const amount = callbackData?.response?.Amount || 5;
      
      let userData;
      
      if (userId) {
        console.log('👤 Using provided user_id:', userId);
        userData = { id: userId };
      } else {
        // Find user by phone (or use a default user for testing)
        const phone = callbackData?.response?.Phone || '';
        console.log('📱 Looking up user by phone:', phone);
        
        const { data: userLookup, error: userError } = await supabase
          .from('users')
          .select('id')
          .eq('phone', phone)
          .single();
        
        if (userError || !userLookup) {
          console.error('❌ Could not find user for phone:', phone);
          console.error('❌ User error:', userError);
          return;
        }
        
        userData = userLookup;
      }
      
      console.log('👤 Found user:', userData.id, 'creating transaction for amount:', amount);
      
      const { error: txError } = await supabase
        .from('transactions')
        .insert([
          {
            user_id: userData.id,
            type: 'deposit',
            amount: amount,
            fee: 0,
            net_amount: amount,
            status: 'completed',
            description: `M-Pesa deposit (${externalRef})`,
            external_reference: externalRef,
            payment_method: 'm-pesa',
            processed_at: new Date().toISOString()
          }
        ]);

      if (txError) {
        console.error('❌ Failed to create direct transaction:', txError);
        console.error('❌ Direct transaction error details:', JSON.stringify(txError, null, 2));
      } else {
        console.log('💳 Direct transaction created successfully');
      }
    } catch (error) {
      console.error('❌ Error in createDirectTransaction:', error);
      console.error('❌ Direct transaction error stack:', error.stack);
    }
  }

  const transactionStatuses = new Map();

  app.post('/api/pay', async (req, res) => {
    let { phone, amount, reference, user_id } = req.body;
    
    console.log('🚀 Payment initiation request:', { phone, amount, reference });
    console.log('🕐 Initiation timestamp:', new Date().toISOString());

    amount = Number(amount);
    const fullPhone = phone.startsWith('254') ? phone : `254${phone}`;
    
    console.log('📱 Formatted phone:', fullPhone);

    const payload = {
      channel_id: process.env.PAYHERO_CHANNEL_ID,
      amount,
      phone_number: fullPhone,
      external_reference: reference,
      callback_url: process.env.CALLBACK_URL,
      provider: 'm-pesa'
    };
    
    console.log('📤 PayHero payload:', JSON.stringify(payload, null, 2));
    console.log('🔗 Callback URL:', process.env.CALLBACK_URL);

    try {
      const response = await axios.post(PAYHERO_API, payload, {
        headers: {
          Authorization: PAYHERO_BASIC_AUTH,
          'Content-Type': 'application/json'
        }
      });

      const data = response.data;
      console.log('✅ PayHero response:', JSON.stringify(data, null, 2));

      const statusKey = data?.external_reference || reference;

      if (statusKey) {
        transactionStatuses.set(statusKey, {
          status: (data.status || 'QUEUED').toUpperCase(),
          details: data.message || 'STK Push initiated, waiting for user confirmation.',
          checkoutRequestID: data.CheckoutRequestID || null,
          lastUpdated: new Date().toISOString(),
          user_id: user_id  // Store user_id for callback use
        });
        
        console.log('💾 Stored in memory with key:', statusKey, 'for user:', user_id);
      }

      res.json({
        status: data.status || 'QUEUED',
        message: data.message || 'STK Push initiated.',
        checkoutRequestID: data.CheckoutRequestID || null,
        external_reference: statusKey,
        raw: data
      });
    } catch (error) {
      console.error('❌ Payment initiation error:', error.response?.data || error.message);
      console.error('❌ Error stack:', error.stack);
      res.status(500).json({
        status: 'Failure',
        message: error.response?.data?.message || error.message || 'Payment failed',
        error: error.response?.data || null
      });
    }
  });

  app.post('/api/callback', async (req, res) => {
    const data = req.body;
    
    // 🔥 LOG ALL CALLBACKS FOR DEBUGGING
    console.log('🔥 PAYMENT CALLBACK RECEIVED:', JSON.stringify(data, null, 2));
    console.log('🕐 Callback timestamp:', new Date().toISOString());
    console.log('📧 Headers:', JSON.stringify(req.headers, null, 2));

    try {
      const statusRaw = data?.response?.Status || data?.status;
      const status = statusRaw ? statusRaw.toUpperCase() : null;
      const externalRef = data?.response?.ExternalReference
        || data?.external_reference
        || data?.response?.external_reference
        || data?.reference;

      console.log('📊 Parsed callback data:', {
        statusRaw,
        status,
        externalRef,
        hasExternalRef: !!externalRef
      });

      if (externalRef) {
        // Store callback data first
        try {
          console.log('🔍 Attempting to insert into payment_callbacks...');
          console.log('📝 Insert data:', {
            external_reference: externalRef,
            status: status,
            callback_data_length: JSON.stringify(data).length
          });
          
          const { data: insertData, error: insertError } = await supabase
            .from('payment_callbacks')
            .insert([{ 
              external_reference: externalRef, 
              callback_data: data, 
              status 
            }])
            .select();
          
          console.log('📊 Insert result:', { insertData, insertError });
          
          if (insertError) {
            console.error('❌ Failed to store callback in payment_callbacks:', insertError);
            console.error('❌ Error code:', insertError.code);
            console.error('❌ Error details:', insertError.details);
            console.error('❌ Error hint:', insertError.hint);
            console.error('❌ Error message:', insertError.message);
            console.error('❌ Full error object:', JSON.stringify(insertError, null, 2));
            
            // Try alternative insert without select to see if that's the issue
            console.log('🔄 Trying alternative insert without .select()...');
            try {
              const { error: altError } = await supabase
                .from('payment_callbacks')
                .insert([{ 
                  external_reference: externalRef, 
                  callback_data: data, 
                  status 
                }]);
              
              if (altError) {
                console.error('❌ Alternative insert also failed:', altError);
              } else {
                console.log('✅ Alternative insert succeeded');
              }
            } catch (altCatchError) {
              console.error('❌ Alternative insert exception:', altCatchError);
            }
          } else {
            console.log('💾 Callback stored in payment_callbacks table');
            console.log('✅ Inserted record ID:', insertData?.[0]?.id);
          }
        } catch (dbError) {
          console.error('❌ Database error during callback insert:', dbError);
          console.error('❌ DB error stack:', dbError.stack);
        }

        try {
          // Only process transactions on VERIFIED SUCCESS
          if (status && status.toLowerCase() === 'success') {
          console.log('✅ Processing successful payment for:', externalRef);
          
          try {
            // Get user_id from memory (stored during payment initiation)
            const memoryData = transactionStatuses.get(externalRef);
            const userId = memoryData?.user_id;
            
            if (!userId) {
              console.error('❌ No user_id found in memory for:', externalRef);
              return;
            }
            
            console.log('👤 Using user_id from memory:', userId);
            
            // Extract amount from callback data
            const amount = data?.response?.Amount || 5;
            console.log('💰 Extracted amount:', amount);
            console.log('📋 Transaction data to insert:', {
              user_id: userId,
              type: 'deposit',
              amount: amount,
              fee: 0,
              net_amount: amount,
              status: 'completed',
              description: `M-Pesa deposit (${externalRef})`,
              external_reference: externalRef,
              payment_method: 'm-pesa',
              processed_at: new Date().toISOString()
            });
            
            // Create transaction directly
            console.log('🔄 Attempting to create transaction...');
            const { data: txData, error: txError } = await supabase
              .from('transactions')
              .insert([
                {
                  user_id: userId,
                  type: 'deposit',
                  amount: amount,
                  fee: 0,
                  net_amount: amount,
                  status: 'completed',
                  description: `M-Pesa deposit (${externalRef})`,
                  external_reference: externalRef,
                  payment_method: 'm-pesa',
                  processed_at: new Date().toISOString()
                }
              ])
              .select();

            console.log('📊 Transaction insert result:', { txData, txError });

            if (txError) {
              console.error('❌ Failed to create transaction:', txError);
              console.error('❌ Transaction error code:', txError.code);
              console.error('❌ Transaction error message:', txError.message);
              console.error('❌ Transaction error details:', JSON.stringify(txError, null, 2));
              
              // Check if it's RLS issue
              if (txError.code === '42501') {
                console.error('🚨 RLS Policy Issue! Transactions table has RLS enabled');
                console.error('💡 Solution: Disable RLS on transactions table or create service role policy');
              }
            } else {
              console.log('💳 Transaction created successfully');
              console.log('✅ Transaction ID:', txData?.[0]?.id);
            }
          } catch (processError) {
            console.error('❌ Error processing successful payment:', processError);
            console.error('❌ Process error stack:', processError.stack);
          }
        } else if (status && status.toLowerCase() === 'failed') {
          console.log('❌ Payment failed for:', externalRef);
        }
        }
      } catch (err) {
        console.error('❌ Callback processing error:', err.message);
        console.error('❌ Error stack:', err.stack);
      }

    res.sendStatus(200);
  });

  app.get('/api/status/:externalRef', async (req, res) => {
    const externalRef = req.params.externalRef;
    
    console.log('🔍 Status check for:', externalRef);
    
    // First check if we have VERIFIED callback data
    try {
      const { data: callbackRows, error: callbackError } = await supabase
        .from('payment_callbacks')
        .select('status, callback_data, created_at')
        .eq('external_reference', externalRef)
        .order('created_at', { ascending: false })
        .limit(1);

      if (callbackError) {
        console.error('❌ Callback query error:', callbackError);
      }

      if (callbackRows && callbackRows.length > 0) {
        const latest = callbackRows[0];
        const normalizedStatus = (latest.status || 'PENDING').toUpperCase();
        
        console.log('✅ Returning verified callback status:', normalizedStatus);
        
        const payload = {
          status: normalizedStatus,
          verified: true,
          source: 'callback',
          full_callback: latest.callback_data,
          lastUpdated: latest.created_at
        };

        // Update memory with verified data
        transactionStatuses.set(externalRef, payload);

        return res.json({
          status: 'Success',
          payment_status: payload,
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error('❌ Callback check error:', error.message);
    }

    // Fallback to memory status if no callback received
    const statusInfo = transactionStatuses.get(externalRef);
    if (statusInfo) {
      console.log('⏳ Returning memory status (unverified):', statusInfo.status);
      
      return res.json({ 
        status: 'Success', 
        payment_status: {
          ...statusInfo,
          verified: false,
          source: 'memory'
        },
        timestamp: new Date().toISOString()
      });
    }

    console.log('❓ No status found for:', externalRef);
    return res.status(202).json({
      status: 'Pending',
      message: 'Payment status not yet available',
      verified: false,
      source: 'none',
      timestamp: new Date().toISOString()
    });
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
