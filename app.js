const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// In-memory storage for payment requests
const transactionStatuses = new Map();

// SwiftWallet API
const SWIFTWALLET_API = 'https://api.swiftwallet.co.ke/v1/stk/push';

// PayHero API
const PAYHERO_API = 'https://backend.payhero.co.ke/api/v2/payments';

// Logging utility
function logProcess(processName, data, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    process: processName,
    level,
    data
  };
  
  console.log(`[${timestamp}] [${level}] ${processName}:`, JSON.stringify(data, null, 2));
}

// Transform SwiftWallet response to PayHero format
function transformSwiftWalletToPayHero(swiftData) {
  const payHeroData = {
    status: swiftData?.status === 'initiated' ? 'QUEUED' : (swiftData?.status || 'FAILED').toUpperCase(),
    message: swiftData?.message || 'STK Push initiated',
    checkoutRequestID: swiftData?.checkout_request_id || null,
    external_reference: swiftData?.external_reference || null
  };
  
  return payHeroData;
}

// Transform SwiftWallet callback to PayHero format
function transformSwiftWalletCallbackToPayHero(swiftCallback) {
  const payHeroCallback = {
    response: {
      Status: swiftCallback?.success === true && (swiftCallback?.status?.toLowerCase() === 'completed' || swiftCallback?.status?.toLowerCase() === 'completed') ? 'Success' : 'Failed',
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

// 🎯 DUAL GATEWAY PAYMENT ENDPOINT
app.post('/api/pay', async (req, res) => {
  logProcess('PAYMENT_INIT', { 
    body: req.body,
    ip: req.ip,
    user_agent: req.get('User-Agent')
  }, 'INFO');

  let { phone, amount, reference, user_id } = req.body;
  
  logProcess('PAYMENT_PARSE', { phone, amount, reference, user_id }, 'DEBUG');
  
  console.log('🚀 Payment initiation request:', { phone, amount, reference });
  console.log('🕐 Initiation timestamp:', new Date().toISOString());

  amount = Number(amount);
  const fullPhone = phone.startsWith('254') ? phone : `254${phone}`;
  
  logProcess('PHONE_FORMAT', { original: phone, formatted: fullPhone }, 'DEBUG');
  console.log('📱 Formatted phone:', fullPhone);

  // 🎯 DUAL GATEWAY DETECTION
  const gateway = reference && reference.toLowerCase().startsWith('payp') ? 'payhero' : 'swiftwallet';
  logProcess('GATEWAY_DETECTION', { reference, gateway }, 'INFO');
  console.log(`🏦 Using gateway: ${gateway.toUpperCase()}`);

  // Generate unique reference
  const timestamp = Date.now().toString().slice(-4);
  const uniqueRef = reference.replace(/[^a-zA-Z0-9]/g, '').substring(0, 4) + timestamp;
  
  logProcess('UNIQUE_REF_GENERATION', { 
    original_reference: reference, 
    unique_ref: uniqueRef,
    gateway 
  }, 'DEBUG');

  if (gateway === 'payhero') {
    // 🏦 PAYHERO GATEWAY LOGIC
    console.log('🏦 Processing via PayHero gateway...');
    
    try {
      // PayHero API payload (EXACT same as original PayHero)
      const payheroPayload = {
        channel_id: process.env.PAYHERO_CHANNEL_ID,
        amount: amount,
        phone_number: fullPhone,
        external_reference: uniqueRef,
        callback_url: process.env.CALLBACK_URL,
        provider: 'm-pesa'
      };
      
      console.log('📤 PayHero payload:', JSON.stringify(payheroPayload, null, 2));
      
      // PayHero Basic Auth
      const authString = `${process.env.PAYHERO_USERNAME || ''}:${process.env.PAYHERO_API_PASSWORD || ''}`;
      const payheroAuth = 'Basic ' + Buffer.from(authString).toString('base64');
      
      // Store payment request for callback matching
      const paymentRequest = {
        phone,
        amount,
        reference,
        user_id,
        uniqueRef,
        gateway: 'payhero',
        timestamp: new Date().toISOString(),
        resolved: false,
        response: null,
        res: res
      };
      
      transactionStatuses.set(uniqueRef, paymentRequest);
      logProcess('PAYHERO_REQUEST_STORED', { 
        uniqueRef, 
        phone, 
        amount,
        total_requests: transactionStatuses.size 
      }, 'INFO');
      
      console.log('💾 PayHero payment request stored, waiting for callback...');
      
      // Call PayHero API
      const payheroResponse = await axios.post(PAYHERO_API, payheroPayload, {
        headers: {
          Authorization: payheroAuth,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });
      
      const payheroData = payheroResponse.data;
      logProcess('PAYHERO_RESPONSE', { 
        response: payheroData,
        status_code: payheroResponse.status
      }, 'SUCCESS');
      
      console.log('✅ PayHero STK Push initiated:', JSON.stringify(payheroData, null, 2));
      
      // Update payment request with PayHero response
      paymentRequest.payheroResponse = payheroData;
      transactionStatuses.set(uniqueRef, paymentRequest);
      
      console.log('⏳ Waiting for PayHero callback (timeout: 2 minutes)...');
      
      // Set timeout for payment completion
      const timeout = setTimeout(() => {
        const request = transactionStatuses.get(uniqueRef);
        if (request && !request.resolved) {
          logProcess('PAYHERO_TIMEOUT', { uniqueRef }, 'WARN');
          console.log('⏰ PayHero payment timeout for:', uniqueRef);
          
          request.resolved = true;
          transactionStatuses.delete(uniqueRef);
          
          request.res.json({
            success: false,
            status: 'TIMEOUT',
            message: 'Payment timed out. Please check your phone and try again.',
            external_reference: uniqueRef,
            gateway: 'payhero'
          });
        }
      }, 120000);

      // Don't respond now - wait for callback
      return;
      
    } catch (error) {
      logProcess('PAYHERO_ERROR', { 
        error: error.message,
        response_data: error.response?.data,
        status_code: error.response?.status
      }, 'ERROR');
      
      console.error('❌ PayHero payment initiation error:', error.response?.data || error.message);
      
      return res.status(500).json({
        status: 'FAILED',
        message: error.response?.data?.message || error.message || 'PayHero payment failed',
        external_reference: uniqueRef
      });
    }
  } else {
    // ⚡ SWIFTWALLET GATEWAY LOGIC
    console.log('⚡ Processing via SwiftWallet gateway...');
    
    const payload = {
      amount: amount,
      phone_number: fullPhone,
      channel_id: process.env.SWIFTWALLET_CHANNEL_ID,
      external_reference: uniqueRef,
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

    // Store payment request in memory for callback matching
    const paymentRequest = {
      phone,
      amount,
      reference,
      user_id,
      uniqueRef,
      gateway: 'swiftwallet',
      timestamp: new Date().toISOString(),
      resolved: false,
      response: null,
      res: res
    };
    
    transactionStatuses.set(uniqueRef, paymentRequest);
    logProcess('SWIFTWALLET_REQUEST_STORED', { 
      uniqueRef, 
      phone, 
      amount,
      total_requests: transactionStatuses.size 
    }, 'INFO');
    
    console.log('💾 SwiftWallet payment request stored, waiting for callback...');

    try {
      logProcess('API_CALL_START', { endpoint: SWIFTWALLET_API }, 'INFO');
      
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
          
          break;
          
        } catch (error) {
          logProcess('API_ERROR', {
            attempt: attempt,
            error: error.message,
            response_data: error.response?.data,
            status_code: error.response?.status,
            stack: error.stack
          }, 'ERROR');
          
          console.error('❌ Payment initiation error:', error.response?.data || error.message);
          
          if (attempt < 3) {
            console.log('🔄 Retrying SwiftWallet API call...');
            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            throw error;
          }
        }
      }

      const swiftData = response.data;
      logProcess('SWIFTWALLET_RESPONSE', { 
        response: swiftData,
        status_code: response.status
      }, 'SUCCESS');
      
      console.log('✅ SwiftWallet STK Push initiated:', JSON.stringify(swiftData, null, 2));

      paymentRequest.swiftResponse = swiftData;
      transactionStatuses.set(uniqueRef, paymentRequest);
      
      console.log('⏳ Waiting for payment callback (timeout: 2 minutes)...');
      
      // Set timeout for payment completion
      const timeout = setTimeout(() => {
        const request = transactionStatuses.get(uniqueRef);
        if (request && !request.resolved) {
          logProcess('PAYMENT_TIMEOUT', { uniqueRef }, 'WARN');
          console.log('⏰ Payment timeout for:', uniqueRef);
          
          request.resolved = true;
          transactionStatuses.delete(uniqueRef);
          
          request.res.json({
            success: false,
            status: 'TIMEOUT',
            message: 'Payment timed out. Please check your phone and try again.',
            external_reference: uniqueRef,
            gateway: 'swiftwallet'
          });
        }
      }, 120000);

      return;
      
    } catch (error) {
      logProcess('PAYMENT_ERROR', { 
        error: error.message,
        response_data: error.response?.data,
        status_code: error.response?.status
      }, 'ERROR');
      
      console.error('❌ Payment initiation error:', error.response?.data || error.message);
      
      return res.status(500).json({
        status: 'FAILED',
        message: error.response?.data?.error || error.message || 'Payment failed',
        external_reference: uniqueRef
      });
    }
  }
});

// 🔄 CALLBACK ENDPOINT
app.post('/api/callback', async (req, res) => {
  const swiftData = req.body;
  
  logProcess('CALLBACK_RECEIVED', {
    headers: req.headers,
    ip: req.ip,
    body_size: JSON.stringify(swiftData).length
  }, 'INFO');
  
  console.log('🔥 SWIFTWALLET CALLBACK RECEIVED:', JSON.stringify(swiftData, null, 2));

  const data = transformSwiftWalletCallbackToPayHero(swiftData);
  logProcess('CALLBACK_TRANSFORM', {
    swift_callback: swiftData,
    payhero_callback: data
  }, 'DEBUG');

  try {
    const statusRaw = data?.response?.Status || data?.status;
    const status = statusRaw ? statusRaw.toUpperCase() : null;
    const externalRef = data?.response?.ExternalReference
      || data?.external_reference
      || data?.reference;

    logProcess('CALLBACK_PARSE', {
      status_raw: statusRaw,
      status: status,
      external_ref: externalRef
    }, 'DEBUG');
    
    const memoryData = transactionStatuses.get(externalRef);
    logProcess('MEMORY_LOOKUP', {
      external_ref: externalRef,
      memory_data: memoryData
    }, 'DEBUG');

    // Check if this is a waiting payment request
    if (memoryData && memoryData.res && !memoryData.resolved) {
      logProcess('WAITING_PAYMENT_FOUND', { 
        external_ref: externalRef,
        status: status,
        gateway: memoryData.gateway
      }, 'INFO');
      
      console.log('🎯 Found waiting payment request, responding to frontend...');
      
      let responseSuccess = false;
      let responseStatus = 'FAILED';
      let responseMessage = 'Payment failed';
      
      if (status === 'SUCCESS' || status === 'COMPLETED') {
        responseSuccess = true;
        responseStatus = 'SUCCESS';
        responseMessage = 'Payment completed successfully';
      } else if (status === 'FAILED') {
        responseSuccess = false;
        responseStatus = 'FAILED';
        responseMessage = 'Payment failed';
      }
      
      // Respond to waiting frontend request
      memoryData.resolved = true;
      memoryData.res.json({
        success: responseSuccess,
        status: responseStatus,
        message: responseMessage,
        external_reference: externalRef,
        amount: memoryData.amount,
        phone: memoryData.phone,
        gateway: memoryData.gateway,
        callback_data: data
      });
      
      // Clean up memory
      transactionStatuses.delete(externalRef);
      
      console.log('✅ Frontend notified of payment result:', responseStatus);
    }

    // Store callback data in database
    try {
      const { error: insertError } = await supabase
        .from('payment_callbacks')
        .insert([
          {
            external_reference: externalRef,
            callback_data: data,
            status
          }
        ]);

      if (insertError) {
        console.error('❌ Failed to store callback:', insertError);
      } else {
        console.log('💾 Callback stored in database');
      }
    } catch (dbError) {
      console.error('❌ Database error:', dbError);
    }

    res.sendStatus(200);
  } catch (err) {
    logProcess('CALLBACK_EXCEPTION', {
      error: err.message,
      stack: err.stack
    }, 'ERROR');
    
    console.error('❌ Callback processing error:', err.message);
    res.sendStatus(200);
  }
});

// 📊 STATUS ENDPOINT
app.get('/api/status/:externalRef', async (req, res) => {
  const externalRef = req.params.externalRef;
  
  logProcess('STATUS_CHECK_START', {
    external_ref: externalRef,
    ip: req.ip
  }, 'INFO');

  try {
    // Check database first
    const { data: callbackRows, error: callbackError } = await supabase
      .from('payment_callbacks')
      .select('*')
      .eq('external_reference', externalRef)
      .order('created_at', { ascending: false })
      .limit(1);

    if (!callbackError && callbackRows && callbackRows.length > 0) {
      const latest = callbackRows[0];
      const normalizedStatus = (latest.status || 'PENDING').toUpperCase();
      
      const payload = {
        status: normalizedStatus,
        details: latest.callback_data?.response?.ResultDesc || 'Payment processed',
        checkoutRequestID: latest.callback_data?.response?.CheckoutRequestID || null,
        lastUpdated: latest.created_at,
        verified: normalizedStatus === 'SUCCESS' || normalizedStatus === 'COMPLETED'
      };

      return res.json({
        success: true,
        payment_status: payload,
        external_reference: externalRef
      });
    }

    // Fallback to memory
    const statusInfo = transactionStatuses.get(externalRef);
    if (statusInfo) {
      return res.json({
        success: true,
        payment_status: {
          status: 'QUEUED',
          details: 'Payment is being processed',
          lastUpdated: statusInfo.timestamp,
          verified: false
        },
        external_reference: externalRef
      });
    }

    // Default pending status
    res.json({
      success: true,
      payment_status: {
        status: 'PENDING',
        details: 'Payment not found',
        lastUpdated: new Date().toISOString(),
        verified: false
      },
      external_reference: externalRef
    });

  } catch (error) {
    logProcess('STATUS_CHECK_ERROR', {
      external_ref: externalRef,
      error: error.message
    }, 'ERROR');
    
    res.status(500).json({
      success: false,
      error: 'Status check failed'
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    active_requests: transactionStatuses.size
  });
});

// Internal ping for self-message scheduler
app.post('/internal/ping', (req, res) => {
  console.log("✅ Self-message received:", req.body);
  res.send("OK");
});

// Create app function for deployment
function createApp() {
  return app;
}

module.exports = { createApp };
