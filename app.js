const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const REQUIRED_ENV_VARS = [
  'SWIFTWALLET_API_KEY',
  'SWIFTWALLET_CHANNEL_ID',
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

  const SWIFTWALLET_API = 'https://swiftwallet.co.ke/v3/stk-initiate/';

  const missingEnv = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missingEnv.length) {
    console.warn(`⚠️ Missing environment variables: ${missingEnv.join(', ')}`);
  }

  const SWIFTWALLET_API_KEY = process.env.SWIFTWALLET_API_KEY || '';

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // Helper function to create transaction directly (EXACT same as PayHero)
  async function createDirectTransaction(externalRef, callbackData, userId = null) {
    try {
      console.log('🔄 Creating direct transaction for:', externalRef);
      
      // Extract amount from callback data (EXACT same as PayHero)
      const amount = callbackData?.response?.Amount || 5;
      
      let userData;
      
      if (userId) {
        console.log('👤 Using provided user_id:', userId);
        userData = { id: userId };
      } else {
        // Find user by phone (EXACT same as PayHero)
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

  // Function to transform SwiftWallet response to PayHero format
  function transformSwiftWalletToPayHero(swiftResponse) {
    return {
      status: swiftResponse?.status?.toLowerCase() === 'initiated' ? 'QUEUED' : (swiftResponse?.status || 'QUEUED'),
      message: swiftResponse?.message || 'STK Push initiated.',
      CheckoutRequestID: swiftResponse?.checkout_request_id || null,
      external_reference: swiftResponse?.reference || swiftResponse?.external_reference
    };
  }

  // Function to transform SwiftWallet callback to PayHero format
  function transformSwiftWalletCallbackToPayHero(swiftCallback) {
    // Create PayHero-compatible callback structure
    const payHeroCallback = {
      response: {
        Status: swiftCallback?.success === true && (swiftCallback?.status === 'completed' || swiftCallback?.status === 'COMPLETED') ? 'Success' : 'Failed',
        Amount: swiftCallback?.result?.Amount || swiftCallback?.amount || 5,
        Phone: swiftCallback?.result?.Phone || '',
        ExternalReference: swiftCallback?.external_reference,
        TransactionDate: swiftCallback?.result?.TransactionDate || new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14),
        MpesaReceiptNumber: swiftCallback?.result?.MpesaReceiptNumber || '',
        ResultCode: swiftCallback?.result?.ResultCode || (swiftCallback?.success === true ? 0 : 1),
        ResultDesc: swiftCallback?.result?.ResultDesc || swiftCallback?.message || 'Transaction processed'
      },
      external_reference: swiftCallback?.external_reference,
      reference: swiftCallback?.external_reference
    };
    
    return payHeroCallback;
  }

  app.post('/api/pay', async (req, res) => {
    let { phone, amount, reference, user_id } = req.body;
    
    console.log('🚀 Payment initiation request:', { phone, amount, reference });
    console.log('🕐 Initiation timestamp:', new Date().toISOString());

    amount = Number(amount);
    const fullPhone = phone.startsWith('254') ? phone : `254${phone}`;
    
    console.log('📱 Formatted phone:', fullPhone);

    // SwiftWallet payload
    const payload = {
      amount: amount,
      phone_number: fullPhone,
      channel_id: process.env.SWIFTWALLET_CHANNEL_ID,
      external_reference: reference,
      callback_url: process.env.CALLBACK_URL
    };
    
    console.log('📤 SwiftWallet payload:', JSON.stringify(payload, null, 2));
    console.log('🔗 Callback URL:', process.env.CALLBACK_URL);

    try {
      const response = await axios.post(SWIFTWALLET_API, payload, {
        headers: {
          Authorization: `Bearer ${SWIFTWALLET_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      const swiftData = response.data;
      console.log('✅ SwiftWallet response:', JSON.stringify(swiftData, null, 2));

      // Transform SwiftWallet response to PayHero format
      const payHeroData = transformSwiftWalletToPayHero(swiftData);
      console.log('🔄 Transformed to PayHero format:', JSON.stringify(payHeroData, null, 2));

      const statusKey = payHeroData?.external_reference || reference;
      console.log('🔑 Using statusKey for memory storage:', statusKey);
      console.log('🔑 Original reference from request:', reference);
      console.log('🔑 PayHero external_reference:', payHeroData?.external_reference);

      if (statusKey) {
        transactionStatuses.set(statusKey, {
          status: (payHeroData.status || 'QUEUED').toUpperCase(),
          details: payHeroData.message || 'STK Push initiated, waiting for user confirmation.',
          checkoutRequestID: payHeroData.CheckoutRequestID || null,
          lastUpdated: new Date().toISOString(),
          user_id: user_id,  // Store user_id for callback use
          verified: false  // Initially not verified
        });
        
        console.log('💾 Stored in memory with key:', statusKey, 'for user:', user_id);
        console.log('📋 Memory contents:', Array.from(transactionStatuses.entries()));
      }

      // Return PayHero-compatible response
      res.json({
        status: payHeroData.status || 'QUEUED',
        message: payHeroData.message || 'STK Push initiated.',
        checkoutRequestID: payHeroData.CheckoutRequestID || null,
        external_reference: statusKey,
        raw: swiftData  // Keep raw for debugging
      });
    } catch (error) {
      console.error('❌ Payment initiation error:', error.response?.data || error.message);
      console.error('❌ Error stack:', error.stack);
      res.status(500).json({
        status: 'Failure',
        message: error.response?.data?.error || error.message || 'Payment failed',
        error: error.response?.data || null
      });
    }
  });

  app.post('/api/callback', async (req, res) => {
    const swiftData = req.body;
    
    // 🔥 LOG ALL CALLBACKS FOR DEBUGGING
    console.log('🔥 SWIFTWALLET CALLBACK RECEIVED:', JSON.stringify(swiftData, null, 2));
    console.log('🕐 Callback timestamp:', new Date().toISOString());
    console.log('📧 Headers:', JSON.stringify(req.headers, null, 2));

    // Transform SwiftWallet callback to PayHero format
    const data = transformSwiftWalletCallbackToPayHero(swiftData);
    console.log('🔄 Transformed to PayHero callback format:', JSON.stringify(data, null, 2));

    try {
      // EXACT same logic as original PayHero callback
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
      
      console.log('🔍 Looking for user_id with key:', externalRef);
      console.log('📋 Current memory contents:', Array.from(transactionStatuses.entries()));
      
      const memoryData = transactionStatuses.get(externalRef);
      console.log('👤 Memory data found:', memoryData);

      if (externalRef) {
        // Store callback data first (EXACT same as PayHero)
        try {
          console.log('🔍 Attempting to insert into payment_callbacks...');
          console.log('📝 Insert data:', {
            external_reference: externalRef,
            status,
            callback_data_length: JSON.stringify(data).length
          });

          const { data: insertData, error: insertError } = await supabase
            .from('payment_callbacks')
            .insert([
              {
                external_reference: externalRef,
                callback_data: data,  // Store PayHero-formatted data
                status
              }
            ])
            .select();

          console.log('📊 Insert result:', { insertData, insertError });

          if (insertError) {
            console.error('❌ Failed to store callback in payment_callbacks:', insertError);
            console.error('❌ Error code:', insertError.code);
            console.error('❌ Error details:', insertError.details);
            console.error('❌ Error hint:', insertError.hint);
            console.error('❌ Error message:', insertError.message);
            console.error('❌ Full error object:', JSON.stringify(insertError, null, 2));

            console.log('🔄 Trying alternative insert without .select()...');
            try {
              const { error: altError } = await supabase
                .from('payment_callbacks')
                .insert([
                  {
                    external_reference: externalRef,
                    callback_data: data,
                    status
                  }
                ]);

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
          // Only process transactions on VERIFIED SUCCESS (EXACT same as PayHero)
          if (status && status.toLowerCase() === 'success') {
            console.log('✅ Processing successful payment for:', externalRef);

            const userId = memoryData?.user_id;

            if (!userId) {
              console.error('❌ No user_id found in memory for:', externalRef);
              return;
            }

            console.log('👤 Using user_id from memory:', userId);

            const amount = data?.response?.Amount || 5;
            console.log('💰 Extracted amount:', amount);
            console.log('📋 Transaction data to insert:', {
              user_id: userId,
              type: 'deposit',
              amount,
              fee: 0,
              net_amount: amount,
              status: 'completed',
              description: `M-Pesa deposit (${externalRef})`,
              external_reference: externalRef,
              payment_method: 'm-pesa',
              processed_at: new Date().toISOString()
            });

            try {
              console.log('🔄 Attempting to create transaction...');
              const { data: txData, error: txError } = await supabase
                .from('transactions')
                .insert([
                  {
                    user_id: userId,
                    type: 'deposit',
                    amount,
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

                if (txError.code === '42501') {
                  console.error('🚨 RLS Policy Issue! Transactions table has RLS enabled');
                  console.error('💡 Solution: Disable RLS on transactions table or create service role policy');
                }
              } else {
                console.log('💳 Transaction created successfully');
                console.log('✅ Transaction ID:', txData?.[0]?.id);
                
                // Update user's recharge_wallet (EXACT same as PayHero)
                try {
                  console.log('💰 Updating user wallet...');
                  console.log('👤 Using user_id from transaction:', userId);
                  
                  // Get current wallet balance
                  const { data: profile, error: profileError } = await supabase
                    .from('users')
                    .select('recharge_wallet')
                    .eq('id', userId)
                    .single();
                  
                  if (profileError) {
                    console.error('❌ Error fetching user profile:', profileError);
                    console.error('❌ This might be an RLS policy issue with the service role');
                    console.log('⚠️ Wallet update failed, but transaction was created');
                    console.log('💡 User exists in database but server cannot access due to RLS');
                  } else {
                    const newBalance = (profile?.recharge_wallet || 0) + amount;
                    console.log('📊 Current recharge_wallet:', profile?.recharge_wallet || 0);
                    console.log('💰 Adding amount:', amount);
                    console.log('🆕 New balance will be:', newBalance);
                    
                    // Update the recharge_wallet
                    const { data: updatedProfile, error: updateError } = await supabase
                      .from('users')
                      .update({ 
                        recharge_wallet: newBalance,
                        updated_at: new Date().toISOString()
                      })
                      .eq('id', userId)
                      .select('recharge_wallet')
                      .single();
                    
                    if (updateError) {
                      console.error('❌ Error updating wallet:', updateError);
                      console.error('❌ This might be an RLS policy issue with the service role');
                    } else {
                      console.log('✅ Wallet updated successfully!');
                      console.log('💰 New recharge_wallet balance:', updatedProfile?.recharge_wallet);
                    }
                  }
                  
                } catch (walletUpdateError) {
                  console.error('❌ Wallet update exception:', walletUpdateError);
                }
              }
            } catch (transactionError) {
              console.error('❌ Error in transaction creation:', transactionError);
              console.error('❌ Transaction error stack:', transactionError.stack);
            }
          } else if (status && status.toLowerCase() === 'failed') {
            console.log('❌ Payment failed for:', externalRef);
          }
          
          // Update memory status with verification (EXACT same as PayHero)
          if (memoryData && externalRef) {
            const isVerified = status && status.toLowerCase() === 'success';
            transactionStatuses.set(externalRef, {
              ...memoryData,
              status: status ? status.toUpperCase() : memoryData.status,
              verified: isVerified,
              lastUpdated: new Date().toISOString()
            });
            console.log(`🔄 Updated memory status for ${externalRef}: ${status?.toUpperCase()}, verified: ${isVerified}`);
          }
        } catch (processBlockError) {
          console.error('❌ Error during payment processing block:', processBlockError);
          console.error('❌ Block error stack:', processBlockError.stack);
        }
      }
    } catch (err) {
      console.error('❌ Callback processing error:', err.message);
      console.error('❌ Error stack:', err.stack);
    }

    res.sendStatus(200);
  });

  // EXACT same as PayHero status endpoint
  app.get('/api/status/:externalRef', async (req, res) => {
    const externalRef = req.params.externalRef;
    const statusInfo = transactionStatuses.get(externalRef);

    if (statusInfo) {
      return res.json({ 
        status: 'Success', 
        payment_status: statusInfo,
        verified: statusInfo.status === 'SUCCESS' || statusInfo.status === 'COMPLETED',
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
          verified: normalizedStatus === 'SUCCESS' || normalizedStatus === 'COMPLETED',
          timestamp: new Date().toISOString()
        });
      }

      return res.status(202).json({
        status: 'Pending',
        message: 'Payment status not yet available',
        verified: false,
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

  // EXACT same as PayHero
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

  // EXACT same as PayHero
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development'
    });
  });

  // EXACT same as PayHero
  app.post('/internal/ping', (req, res) => {
    console.log("✅ Self-message received:", req.body);
    res.send("OK");
  });

  return app;
};

module.exports = { createApp };
