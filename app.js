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

  // 📊 COMPREHENSIVE LOGGING SYSTEM
  const logProcess = (processName, data, level = 'INFO') => {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      process: processName,
      data
    };
    
    switch(level) {
      case 'INFO':
        console.log(`ℹ️ [${processName}] ${timestamp}:`, data);
        break;
      case 'SUCCESS':
        console.log(`✅ [${processName}] ${timestamp}:`, data);
        break;
      case 'ERROR':
        console.error(`❌ [${processName}] ${timestamp}:`, data);
        break;
      case 'WARN':
        console.warn(`⚠️ [${processName}] ${timestamp}:`, data);
        break;
      case 'DEBUG':
        console.log(`🔍 [${processName}] ${timestamp}:`, data);
        break;
    }
  };

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

  logProcess('SERVER_INIT', 'SwiftWallet server starting up');

  const SWIFTWALLET_API = 'https://swiftwallet.co.ke/v3/stk-initiate/';

  const missingEnv = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missingEnv.length) {
    logProcess('ENV_CHECK', { missing_vars: missingEnv }, 'WARN');
  } else {
    logProcess('ENV_CHECK', { status: 'All environment variables loaded' }, 'SUCCESS');
  }

  const SWIFTWALLET_API_KEY = process.env.SWIFTWALLET_API_KEY || '';

  logProcess('SUPABASE_INIT', { url: process.env.SUPABASE_URL }, 'INFO');

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  logProcess('SUPABASE_CLIENT', { status: 'Supabase client initialized' }, 'SUCCESS');

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
    logProcess('PAYMENT_INIT', { 
      body: req.body,
      ip: req.ip,
      user_agent: req.get('User-Agent')
    }, 'INFO');

    let { phone, amount, reference, user_id } = req.body;
    
    logProcess('PAYMENT_PARSE', { phone, amount, reference, user_id }, 'DEBUG');
    
    // 🔍 DETAILED PAYLOAD ANALYSIS
    console.log('🔍 === FRONTEND PAYLOAD ANALYSIS ===');
    console.log('📋 Raw request body:', JSON.stringify(req.body, null, 2));
    console.log('📋 Parsed variables:', { phone, amount, reference, user_id });
    console.log('📋 Reference type:', typeof reference);
    console.log('📋 Reference length:', reference ? reference.length : 'undefined');
    console.log('📋 Reference characters:', reference ? reference.split('') : 'undefined');
    console.log('� User ID type:', typeof user_id);
    console.log('📋 User ID value:', user_id);
    console.log('📋 All request headers:', JSON.stringify(req.headers, null, 2));
    console.log('� === END ANALYSIS ===');
    
    console.log('🚀 Payment initiation request:', { phone, amount, reference });
    console.log('🕐 Initiation timestamp:', new Date().toISOString());

    amount = Number(amount);
    const fullPhone = phone.startsWith('254') ? phone : `254${phone}`;
    
    logProcess('PHONE_FORMAT', { original: phone, formatted: fullPhone }, 'DEBUG');
    console.log('📱 Formatted phone:', fullPhone);

    // SwiftWallet payload
    const timestamp = Date.now().toString().slice(-4); // Last 4 digits of timestamp
    const uniqueRef = reference.replace(/[^a-zA-Z0-9]/g, '').substring(0, 4) + timestamp;
    
    const payload = {
      amount: amount,
      phone_number: fullPhone,
      channel_id: process.env.SWIFTWALLET_CHANNEL_ID,
      external_reference: uniqueRef, // Unique reference to avoid duplicates
      callback_url: process.env.CALLBACK_URL,
      customer_name: user_id ? `User${user_id}` : "Customer",
      occasion: "Wallet Deposit"
    };
    
    logProcess('SWIFTWALLET_REQUEST', { 
      payload,
      api_url: SWIFTWALLET_API,
      channel_id: process.env.SWIFTWALLET_CHANNEL_ID
    }, 'INFO');
    
    console.log('📤 SwiftWallet payload:', JSON.stringify(payload, null, 2));
    console.log('🔗 Callback URL:', process.env.CALLBACK_URL);

    try {
      logProcess('API_CALL_START', { endpoint: SWIFTWALLET_API }, 'INFO');
      
      // Add retry logic for SwiftWallet API
      let lastError;
      let response;
      
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          logProcess('API_ATTEMPT', { attempt, max_attempts: 3 }, 'INFO');
          
          response = await axios.post(SWIFTWALLET_API, payload, {
            headers: {
              Authorization: `Bearer ${process.env.SWIFTWALLET_API_KEY}`,
              'Content-Type': 'application/json'
            },
            timeout: 30000
          });

          logProcess('API_SUCCESS', {
            attempt: attempt,
            status: response.status,
            data: response.data
          }, 'SUCCESS');
          
          // Success! Break out of retry loop
          break;
          
        } catch (error) {
          lastError = error;
          logProcess('API_ERROR', {
            attempt: attempt,
            error: error.message,
            response_data: error.response?.data,
            status_code: error.response?.status,
            stack: error.stack
          }, 'ERROR');
          
          console.error('❌ Payment initiation error:', error.response?.data || error.message);
          console.error('❌ Error stack:', error.stack);
          
          if (attempt < 3) {
            console.log('🔄 Retrying SwiftWallet API call...');
            // Wait 2 seconds before retry
            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            throw error;
          }
        }
      }

      const swiftData = response.data;
      logProcess('SWIFTWALLET_RESPONSE', { 
        response: swiftData,
        status_code: response.status,
        response_time: response.headers['x-response-time']
      }, 'SUCCESS');
      
      console.log('✅ SwiftWallet response:', JSON.stringify(swiftData, null, 2));

      // Transform SwiftWallet response to PayHero format
      const payHeroData = transformSwiftWalletToPayHero(swiftData);
      logProcess('RESPONSE_TRANSFORM', { 
        swift_response: swiftData,
        payhero_response: payHeroData 
      }, 'DEBUG');
      
      console.log('🔄 Transformed to PayHero format:', JSON.stringify(payHeroData, null, 2));

      const statusKey = payHeroData?.external_reference || reference;
      logProcess('MEMORY_KEY', { 
        original_reference: reference,
        status_key: statusKey,
        payhero_external_ref: payHeroData?.external_reference 
      }, 'DEBUG');
      
      console.log('🔑 Using statusKey for memory storage:', statusKey);
      console.log('🔑 Original reference from request:', reference);
      console.log('🔑 PayHero external_reference:', payHeroData?.external_reference);

      if (statusKey) {
        const memoryData = {
          status: (payHeroData.status || 'QUEUED').toUpperCase(),
          details: payHeroData.message || 'STK Push initiated, waiting for user confirmation.',
          checkoutRequestID: payHeroData.CheckoutRequestID || null,
          lastUpdated: new Date().toISOString(),
          user_id: user_id,  // Store user_id for callback use
          verified: false  // Initially not verified
        };
        
        transactionStatuses.set(statusKey, memoryData);
        
        logProcess('MEMORY_STORE', { 
          key: statusKey, 
          data: memoryData,
          total_memory_size: transactionStatuses.size 
        }, 'SUCCESS');
        
        console.log('💾 Stored in memory with key:', statusKey, 'for user:', user_id);
        console.log('📋 Memory contents:', Array.from(transactionStatuses.entries()));
      }

      // Return PayHero-compatible response
      const finalResponse = {
        status: payHeroData.status || 'QUEUED',
        message: payHeroData.message || 'STK Push initiated.',
        checkoutRequestID: payHeroData.CheckoutRequestID || null,
        external_reference: statusKey,
        raw: swiftData  // Keep raw for debugging
      };
      
      logProcess('FINAL_RESPONSE', { response: finalResponse }, 'INFO');
      res.json(finalResponse);
      
    } catch (error) {
      logProcess('PAYMENT_ERROR', { 
        error: error.message,
        response_data: error.response?.data,
        status_code: error.response?.status,
        stack: error.stack
      }, 'ERROR');
      
      console.error('❌ Payment initiation error:', error.response?.data || error.message);
      console.error('❌ Error stack:', error.stack);
      
      // Graceful fallback when SwiftWallet is down
      if (error.response?.status === 500 && error.response?.data?.error === 'Failed to create transaction record') {
        logProcess('SWIFTWALLET_DOWN', { 
          error: 'SwiftWallet database issue',
          fallback: true
        }, 'WARN');
        
        console.log('⚠️ SwiftWallet database issue - providing fallback response');
        
        return res.status(200).json({
          status: 'PENDING',
          message: 'Payment queued. Please check your phone in a few moments.',
          checkoutRequestID: `SWIFT_FALLBACK_${Date.now()}`,
          external_reference: uniqueRef,
          raw: {
            success: true,
            status: 'PENDING',
            message: 'Payment queued. Please check your phone in a few moments.',
            reference: uniqueRef,
            transaction_id: null,
            fallback: true
          }
        });
      }
      
      return res.status(500).json({
        status: 'Failure',
        message: error.response?.data?.error || error.message || 'Payment failed',
        error: error.response?.data || null
      });
    }
  });

  app.post('/api/callback', async (req, res) => {
    const swiftData = req.body;
    
    logProcess('CALLBACK_RECEIVED', {
      headers: req.headers,
      ip: req.ip,
      body_size: JSON.stringify(swiftData).length
    }, 'INFO');
    
    // 🔥 LOG ALL CALLBACKS FOR DEBUGGING
    console.log('🔥 SWIFTWALLET CALLBACK RECEIVED:', JSON.stringify(swiftData, null, 2));
    console.log('🕐 Callback timestamp:', new Date().toISOString());
    console.log('📧 Headers:', JSON.stringify(req.headers, null, 2));

    // Transform SwiftWallet callback to PayHero format
    const data = transformSwiftWalletCallbackToPayHero(swiftData);
    logProcess('CALLBACK_TRANSFORM', {
      swift_callback: swiftData,
      payhero_callback: data
    }, 'DEBUG');
    
    console.log('🔄 Transformed to PayHero callback format:', JSON.stringify(data, null, 2));

    try {
      // EXACT same logic as original PayHero callback
      const statusRaw = data?.response?.Status || data?.status;
      const status = statusRaw ? statusRaw.toUpperCase() : null;
      const externalRef = data?.response?.ExternalReference
        || data?.external_reference
        || data?.response?.external_reference
        || data?.reference;

      logProcess('CALLBACK_PARSE', {
        status_raw: statusRaw,
        status: status,
        external_ref: externalRef,
        has_external_ref: !!externalRef
      }, 'DEBUG');
      
      console.log('📊 Parsed callback data:', {
        statusRaw,
        status,
        externalRef,
        hasExternalRef: !!externalRef
      });
      
      console.log('🔍 Looking for user_id with key:', externalRef);
      console.log('📋 Current memory contents:', Array.from(transactionStatuses.entries()));
      
      const memoryData = transactionStatuses.get(externalRef);
      logProcess('MEMORY_LOOKUP', {
        external_ref: externalRef,
        memory_data: memoryData,
        memory_size: transactionStatuses.size
      }, 'DEBUG');
      
      console.log('👤 Memory data found:', memoryData);

      if (externalRef) {
        // Store callback data first (EXACT same as PayHero)
        try {
          logProcess('DB_CALLBACK_INSERT_START', {
            external_ref: externalRef,
            status: status,
            callback_data_size: JSON.stringify(data).length
          }, 'INFO');
          
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

          logProcess('DB_CALLBACK_INSERT_RESULT', {
            insert_data: insertData,
            insert_error: insertError,
            success: !insertError
          }, insertError ? 'ERROR' : 'SUCCESS');

          console.log('📊 Insert result:', { insertData, insertError });

          if (insertError) {
            logProcess('DB_CALLBACK_INSERT_ERROR', {
              error_code: insertError.code,
              error_message: insertError.message,
              error_details: insertError.details,
              error_hint: insertError.hint,
              full_error: JSON.stringify(insertError, null, 2)
            }, 'ERROR');
            
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

              logProcess('DB_CALLBACK_ALT_RESULT', {
                alt_error: altError,
                alt_success: !altError
              }, altError ? 'ERROR' : 'SUCCESS');

              if (altError) {
                console.error('❌ Alternative insert also failed:', altError);
              } else {
                console.log('✅ Alternative insert succeeded');
              }
            } catch (altCatchError) {
              logProcess('DB_CALLBACK_ALT_EXCEPTION', {
                exception: altCatchError.message,
                stack: altCatchError.stack
              }, 'ERROR');
              
              console.error('❌ Alternative insert exception:', altCatchError);
            }
          } else {
            logProcess('DB_CALLBACK_INSERT_SUCCESS', {
              record_id: insertData?.[0]?.id,
              external_ref: externalRef
            }, 'SUCCESS');
            
            console.log('💾 Callback stored in payment_callbacks table');
            console.log('✅ Inserted record ID:', insertData?.[0]?.id);
          }
        } catch (dbError) {
          logProcess('DB_CALLBACK_EXCEPTION', {
            exception: dbError.message,
            stack: dbError.stack
          }, 'ERROR');
          
          console.error('❌ Database error during callback insert:', dbError);
          console.error('❌ DB error stack:', dbError.stack);
        }

        try {
          logProcess('TRANSACTION_PROCESS_START', {
            external_ref: externalRef,
            status: status,
            user_id: memoryData?.user_id
          }, 'INFO');

          const userId = memoryData?.user_id;

          if (!userId) {
            logProcess('TRANSACTION_NO_USER', { external_ref: externalRef }, 'ERROR');
            console.error('❌ No user_id found in memory for:', externalRef);
            return;
          }

          logProcess('TRANSACTION_USER_FOUND', { user_id: userId }, 'SUCCESS');
          console.log('👤 Using user_id from memory:', userId);

          const amount = data?.response?.Amount || 5;
          logProcess('TRANSACTION_AMOUNT', { amount, source: 'callback_data' }, 'DEBUG');
          
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
            logProcess('DB_TRANSACTION_INSERT_START', {
              user_id: userId,
              amount: amount,
              external_ref: externalRef
            }, 'INFO');
            
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

            logProcess('DB_TRANSACTION_INSERT_RESULT', {
              transaction_data: txData,
              transaction_error: txError,
              success: !txError
            }, txError ? 'ERROR' : 'SUCCESS');

            console.log('📊 Transaction insert result:', { txData, txError });

            if (txError) {
              logProcess('DB_TRANSACTION_ERROR', {
                error_code: txError.code,
                error_message: txError.message,
                error_details: txError.details,
                full_error: JSON.stringify(txError, null, 2)
              }, 'ERROR');
              
              console.error('❌ Failed to create transaction:', txError);
              console.error('❌ Transaction error code:', txError.code);
              console.error('❌ Transaction error message:', txError.message);
              console.error('❌ Transaction error details:', JSON.stringify(txError, null, 2));

              if (txError.code === '42501') {
                logProcess('RLS_POLICY_ERROR', { table: 'transactions' }, 'ERROR');
                console.error('🚨 RLS Policy Issue! Transactions table has RLS enabled');
                console.error('💡 Solution: Disable RLS on transactions table or create service role policy');
              }
            } else {
              logProcess('TRANSACTION_CREATED', {
                transaction_id: txData?.[0]?.id,
                user_id: userId,
                amount: amount
              }, 'SUCCESS');
              
              console.log('💳 Transaction created successfully');
              console.log('✅ Transaction ID:', txData?.[0]?.id);
              
              // Update user's recharge_wallet (EXACT same as PayHero)
              try {
                logProcess('WALLET_UPDATE_START', {
                  user_id: userId,
                  current_amount: amount
                }, 'INFO');
                
                console.log('💰 Updating user wallet...');
                console.log('👤 Using user_id from transaction:', userId);
                
                // Get current wallet balance
                const { data: profile, error: profileError } = await supabase
                  .from('users')
                  .select('recharge_wallet')
                  .eq('id', userId)
                  .single();
                
                if (profileError) {
                  logProcess('WALLET_FETCH_ERROR', {
                    user_id: userId,
                    error: profileError.message
                  }, 'ERROR');
                  
                  console.error('❌ Error fetching user profile:', profileError);
                  console.error('❌ This might be an RLS policy issue with the service role');
                  console.log('⚠️ Wallet update failed, but transaction was created');
                  console.log('💡 User exists in database but server cannot access due to RLS');
                } else {
                  const newBalance = (profile?.recharge_wallet || 0) + amount;
                  logProcess('WALLET_BALANCE_CALC', {
                    current_balance: profile?.recharge_wallet || 0,
                    amount_to_add: amount,
                    new_balance: newBalance
                  }, 'DEBUG');
                  
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
                  
                  logProcess('WALLET_UPDATE_RESULT', {
                    update_error: updateError,
                    updated_balance: newBalance,
                    success: !updateError
                  }, updateError ? 'ERROR' : 'SUCCESS');
                  
                  if (updateError) {
                    logProcess('WALLET_UPDATE_ERROR', {
                      user_id: userId,
                      error: updateError.message
                    }, 'ERROR');
                    
                    console.error('❌ Error updating wallet:', updateError);
                    console.error('❌ This might be an RLS policy issue with the service role');
                  } else {
                    logProcess('WALLET_UPDATE_SUCCESS', {
                      user_id: userId,
                      old_balance: profile?.recharge_wallet || 0,
                      new_balance: newBalance,
                      amount_added: amount
                    }, 'SUCCESS');
                    
                    console.log('✅ Wallet updated successfully!');
                    console.log('💰 New recharge_wallet balance:', updatedProfile?.recharge_wallet);
                  }
                }
                
              } catch (walletUpdateError) {
                logProcess('WALLET_UPDATE_EXCEPTION', {
                  user_id: userId,
                  exception: walletUpdateError.message,
                  stack: walletUpdateError.stack
                }, 'ERROR');
                
                console.error('❌ Wallet update exception:', walletUpdateError);
              }
            }
          } catch (transactionError) {
            logProcess('TRANSACTION_EXCEPTION', {
              external_ref: externalRef,
              exception: transactionError.message,
              stack: transactionError.stack
            }, 'ERROR');
            
            console.error('❌ Error in transaction creation:', transactionError);
            console.error('❌ Transaction error stack:', transactionError.stack);
          }
        if (status && status.toLowerCase() === 'failed') {
            logProcess('TRANSACTION_FAILED', { external_ref: externalRef, status: status }, 'INFO');
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
          logProcess('CALLBACK_PROCESSING_ERROR', {
            external_ref: externalRef,
            error: processBlockError.message,
            stack: processBlockError.stack
          }, 'ERROR');
          
          console.error('❌ Callback processing error:', processBlockError.message);
          console.error('❌ Error stack:', processBlockError.stack);
        }
        
        console.error('❌ Callback processing error:', processBlockError.message);
        console.error('❌ Error stack:', processBlockError.stack);
      }

      res.sendStatus(200);
    } catch (err) {
      logProcess('CALLBACK_EXCEPTION', {
        error: err.message,
        stack: err.stack
      }, 'ERROR');
      
      console.error('❌ Callback processing error:', err.message);
      console.error('❌ Error stack:', err.stack);
      res.sendStatus(200);
    }
  });

  // EXACT same as PayHero status endpoint
  app.get('/api/status/:externalRef', async (req, res) => {
    const externalRef = req.params.externalRef;
    logProcess('STATUS_CHECK_START', {
      external_ref: externalRef,
      ip: req.ip,
      user_agent: req.get('User-Agent')
    }, 'INFO');
    
    const statusInfo = transactionStatuses.get(externalRef);
    logProcess('STATUS_MEMORY_LOOKUP', {
      external_ref: externalRef,
      status_info: statusInfo,
      memory_size: transactionStatuses.size
    }, 'DEBUG');

    if (statusInfo) {
      logProcess('STATUS_MEMORY_FOUND', {
        external_ref: externalRef,
        status: statusInfo.status,
        verified: statusInfo.status === 'SUCCESS' || statusInfo.status === 'COMPLETED'
      }, 'SUCCESS');
      
      return res.json({ 
        status: 'Success', 
        payment_status: statusInfo,
        verified: statusInfo.status === 'SUCCESS' || statusInfo.status === 'COMPLETED',
        timestamp: new Date().toISOString()
      });
    }

    try {
      logProcess('STATUS_DB_LOOKUP_START', {
        external_ref: externalRef
      }, 'INFO');
      
      const { data: callbackRows, error: callbackError } = await supabase
        .from('payment_callbacks')
        .select('status, callback_data, created_at')
        .eq('external_reference', externalRef)
        .order('created_at', { ascending: false })
        .limit(1);

      if (callbackError) {
        logProcess('STATUS_DB_ERROR', {
          external_ref: externalRef,
          error: callbackError.message
        }, 'ERROR');
        throw callbackError;
      }

      logProcess('STATUS_DB_LOOKUP_RESULT', {
        external_ref: externalRef,
        callback_rows: callbackRows,
        has_data: callbackRows && callbackRows.length > 0
      }, 'SUCCESS');

      if (callbackRows && callbackRows.length > 0) {
        const latest = callbackRows[0];
        const normalizedStatus = (latest.status || 'PENDING').toUpperCase();
        const payload = {
          status: normalizedStatus,
          full_callback: latest.callback_data,
          lastUpdated: latest.created_at
        };

        logProcess('STATUS_PAYLOAD_CREATED', {
          external_ref: externalRef,
          normalized_status: normalizedStatus,
          last_updated: latest.created_at
        }, 'DEBUG');

        transactionStatuses.set(externalRef, payload);

        logProcess('STATUS_MEMORY_UPDATE', {
          external_ref: externalRef,
          payload: payload
        }, 'SUCCESS');

        const finalResponse = {
          status: 'Success',
          payment_status: payload,
          verified: normalizedStatus === 'SUCCESS' || normalizedStatus === 'COMPLETED',
          timestamp: new Date().toISOString()
        };

        logProcess('STATUS_FINAL_RESPONSE', {
          external_ref: externalRef,
          response: finalResponse
        }, 'INFO');

        return res.json(finalResponse);
      }

      logProcess('STATUS_NO_DATA', {
        external_ref: externalRef
      }, 'WARN');

      return res.status(202).json({
        status: 'Pending',
        message: 'Payment status not yet available',
        verified: false,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logProcess('STATUS_EXCEPTION', {
        external_ref: externalRef,
        error: error.message,
        stack: error.stack
      }, 'ERROR');
      
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
