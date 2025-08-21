// // Lambda@Edge OAuth Callback Function
// // This function handles the OAuth callback from Cognito
// // Runtime: Node.js 18.x

const https = require('https');
const querystring = require('querystring');

const CONFIG = require('../config');

// Parse cookies from request headers
function parseCookies(cookieHeader) {
  const cookies = {};
  if (cookieHeader && typeof cookieHeader === 'string') {
    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      if (name && value) {
        cookies[name] = decodeURIComponent(value);
      }
    });
  }
  return cookies;
}

// Make HTTPS request to Cognito
function makeHttpsRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          resolve({ statusCode: res.statusCode, data: response });
        } catch (error) {
          resolve({ statusCode: res.statusCode, data: data });
        }
      });
    });
    
    req.on('error', reject);
    
    if (postData) {
      req.write(postData);
    }
    
    req.end();
  });
}

// Exchange authorization code for JWT tokens
async function exchangeCodeForTokens(code, codeVerifier) {
  const tokenEndpoint = `${CONFIG.USER_POOL_DOMAIN}/oauth2/token`;
  const url = new URL(tokenEndpoint);
  
  const postData = querystring.stringify({
    grant_type: 'authorization_code',
    client_id: CONFIG.USER_POOL_CLIENT_ID,
    code: code,
    redirect_uri: CONFIG.REDIRECT_URI,
    code_verifier: codeVerifier
  });
  
  const options = {
    hostname: url.hostname,
    port: 443,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    }
  };
  
  console.log('Exchanging code for tokens...');
  
  try {
    const response = await makeHttpsRequest(options, postData);
    
    if (response.statusCode === 200) {
      console.log('Token exchange successful');
      return response.data;
    } else {
      console.error('Token exchange failed:', response.statusCode, response.data);
      throw new Error(`Token exchange failed: ${response.statusCode}`);
    }
  } catch (error) {
    console.error('Error exchanging code for tokens:', error);
    throw error;
  }
}

// Create success response with JWT cookies
function createSuccessResponse(tokens, originalUri) {
  const idToken = tokens.id_token;
  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;
  const expiresIn = tokens.expires_in || 3600; // Default to 1 hour
  
  const redirectUri = originalUri || '/';
  
  console.log('Setting authentication cookies and redirecting to:', redirectUri);
  
  // Create secure cookies
  const cookies = [
    `${CONFIG.COOKIE_SETTINGS.idToken}=${idToken}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${expiresIn}`,
    `${CONFIG.COOKIE_SETTINGS.accessToken}=${accessToken}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${expiresIn}`,
    `${CONFIG.COOKIE_SETTINGS.refreshToken}=${refreshToken}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`, // 7 days
    `${CONFIG.COOKIE_SETTINGS.pkce}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` // Clear PKCE cookie
  ];
  
  return {
    status: '302',
    statusDescription: 'Found',
    headers: {
      location: [{
        key: 'Location',
        value: redirectUri
      }],
      'set-cookie': cookies.map(cookie => ({
        key: 'Set-Cookie',
        value: cookie
      })),
      'cache-control': [{
        key: 'Cache-Control',
        value: 'no-cache, no-store, must-revalidate'
      }]
    }
  };
}

// Create error response
function createErrorResponse(error, description = '') {
  console.error('Authentication error:', error, description);
  
  const errorHtml = `
  <!DOCTYPE html>
  <html>
  <head>
      <title>Authentication Error</title>
      <style>
          body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
              margin: 0; padding: 40px; background: #f5f5f5; 
          }
          .container { 
              max-width: 600px; margin: 0 auto; background: white; 
              padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); 
          }
          .error { 
              background: #fee; border: 1px solid #fcc; 
              padding: 20px; border-radius: 4px; margin-bottom: 20px; 
          }
          .retry-btn {
              display: inline-block; padding: 12px 24px; 
              background: #007bff; color: white; text-decoration: none; 
              border-radius: 4px; margin-top: 20px;
          }
      </style>
  </head>
  <body>
      <div class="container">
          <h1>Authentication Error</h1>
          <div class="error">
              <p><strong>Error:</strong> ${error}</p>
              ${description ? `<p><strong>Description:</strong> ${description}</p>` : ''}
          </div>
          <p>There was a problem with the authentication process. Please try signing in again.</p>
          <a href="/signin" class="retry-btn">Try Again</a>
      </div>
  </body>
  </html>`;
  
  return {
    status: '400',
    statusDescription: 'Bad Request',
    headers: {
      'content-type': [{
        key: 'Content-Type',
        value: 'text/html; charset=UTF-8'
      }],
      'cache-control': [{
        key: 'Cache-Control',
        value: 'no-cache, no-store, must-revalidate'
      }]
    },
    body: errorHtml
  };
}

exports.handler = async (event) => {
  console.log('=== CALLBACK FUNCTION DEBUG ===');
  console.log('Event:', JSON.stringify(event, null, 2));
  
  if (!event || !event.Records || !Array.isArray(event.Records) || event.Records.length === 0) {
      console.error('Invalid event structure');
      return createErrorResponse('invalid_event', 'Invalid CloudFront event structure');
  }
  
  const record = event.Records[0];
  if (!record.cf || !record.cf.request) {
      console.error('Invalid CloudFront record structure');
      return createErrorResponse('invalid_cf_record', 'Invalid CloudFront record structure');
  }
  
  const request = record.cf.request;
  const queryString = request.querystring || '';
  const headers = request.headers || {};
  
  console.log('Query string:', queryString);
  console.log('Headers:', JSON.stringify(headers, null, 2));
  
  // Parse query parameters
  const params = querystring.parse(queryString);
  const code = params.code;
  const state = params.state;
  const error = params.error;
  
  console.log('Parsed params:', { code, state, error });
  
  // Handle OAuth errors from Cognito
  if (error) {
      console.error('OAuth error:', error);
      return createErrorResponse(error, params.error_description);
  }
  
  // Check for authorization code
  if (!code) {
      console.error('No authorization code found');
      return createErrorResponse('missing_code', 'No authorization code received from Cognito');
  }
  
  // Get PKCE data from cookies
  let cookieHeader = '';
  if (headers.cookie && Array.isArray(headers.cookie) && headers.cookie.length > 0) {
      cookieHeader = headers.cookie[0].value || '';
  }
  
  console.log('Cookie header:', cookieHeader);
  
  const cookies = parseCookies(cookieHeader);
  const pkceData = cookies[CONFIG.COOKIE_SETTINGS.pkce];
  
  console.log('PKCE data:', pkceData);
  
  if (!pkceData) {
      console.error('No PKCE data found in cookies');
      return createErrorResponse('missing_pkce', 'PKCE verification data not found');
  }
  
  let pkceInfo;
  try {
      pkceInfo = JSON.parse(pkceData);
      console.log('Parsed PKCE info:', pkceInfo);
  } catch (error) {
      console.error('Failed to parse PKCE data:', error);
      return createErrorResponse('invalid_pkce', 'Invalid PKCE verification data');
  }
  
  // Verify state parameter (CSRF protection)
  if (state !== pkceInfo.state) {
      console.error('State mismatch:', { received: state, expected: pkceInfo.state });
      return createErrorResponse('state_mismatch', 'State parameter validation failed');
  }
  
  try {
      console.log('Exchanging code for tokens...');
      const tokens = await exchangeCodeForTokens(code, pkceInfo.codeVerifier);
      console.log('Token exchange successful');
      
      return createSuccessResponse(tokens, pkceInfo.originalUri);
      
  } catch (error) {
      console.error('Token exchange error:', error);
      return createErrorResponse('token_exchange_failed', error.message);
  }
};