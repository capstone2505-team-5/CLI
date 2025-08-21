'use strict';

const jwt = require('jsonwebtoken');
const CONFIG = require('./config');

const redirectToLogin = (host) => {
  const clientId = CONFIG.USER_POOL_CLIENT_ID;
  const redirectUri = CONFIG.REDIRECT_URI;
  const cognitoDomain = CONFIG.USER_POOL_DOMAIN;

  // Handle case where cognitoDomain already includes https://
  const domain = cognitoDomain.startsWith('https://') ? cognitoDomain : `https://${cognitoDomain}`;
  const loginUrl = `${domain}/login?client_id=${clientId}&response_type=token&scope=email+openid&redirect_uri=${redirectUri}`;
  return {
    status: '302',
    statusDescription: 'Found',
    headers: {
      location: [{ key: 'Location', value: loginUrl }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-cache' }],
    },
  };
};

exports.handler = async (event) => {
  const request = event.Records[0].cf.request;

  // Allow the callback path without auth check
  if (request.uri.startsWith('/callback')) {
    return request; // bypass auth, allow request through
  }

  const headers = request.headers;
  const host = headers.host[0].value;
  const cookies = headers.cookie ? headers.cookie[0].value : '';
  
  // Look for both possible cookie names
  const idTokenMatch = cookies.match(/id_token=([^;]+)/) || cookies.match(/spa-id-token=([^;]+)/);

  if (!idTokenMatch) {
    return redirectToLogin(host);
  }

  const token = idTokenMatch[1];

  try {
    const decoded = jwt.decode(token, { complete: true });

    // Optional: add additional checks
    if (!decoded || !decoded.payload || Date.now() / 1000 > decoded.payload.exp) {
      return redirectToLogin(host);
    }

    // For API requests, add the Authorization header
    if (request.uri.startsWith('/api/')) {
      console.log('Processing API request for URI:', request.uri);
      
      // Add Authorization header with the token
      if (!request.headers.authorization) {
        request.headers.authorization = [{
          key: 'Authorization',
          value: `Bearer ${token}`
        }];
      }
      
      console.log('Authorization header added successfully');
    }

    return request; // Allow the request to continue
  } catch (err) {
    console.log('Token decode failed:', err);
    return redirectToLogin(host);
  }
};
