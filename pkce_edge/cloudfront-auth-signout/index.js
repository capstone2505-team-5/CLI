// Lambda@Edge Sign Out Function
// This function clears authentication cookies and logs out from Cognito

// Configuration - Update these with your actual values
const CONFIG = require('../config');

// Parse query string parameters
function parseQueryString(queryString) {
  const params = {};
  if (queryString) {
      queryString.split('&').forEach(param => {
          const [key, value] = param.split('=');
          if (key && value) {
              params[decodeURIComponent(key)] = decodeURIComponent(value);
          }
      });
  }
  return params;
}

// Main Lambda handler
exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  const queryString = request.querystring;
  
  console.log('Processing sign out request');
  
  // Parse query parameters - allows specifying where to redirect after logout
  const params = parseQueryString(queryString);
  const redirectAfterLogout = params.redirect || CONFIG.LOGOUT_URI;
  
  console.log('Will redirect to after logout:', redirectAfterLogout);
  
  // Build Cognito logout URL
  const logoutParams = new URLSearchParams({
      client_id: CONFIG.USER_POOL_CLIENT_ID,
      logout_uri: redirectAfterLogout,
      redirect_uri: redirectAfterLogout
  });
  
  const logoutUrl = `${CONFIG.USER_POOL_DOMAIN}/logout?${logoutParams.toString()}`;
  
  // Clear all authentication cookies by setting them to expire immediately
  const cookiesToClear = [
      CONFIG.COOKIE_SETTINGS.idToken,
      CONFIG.COOKIE_SETTINGS.accessToken,
      CONFIG.COOKIE_SETTINGS.refreshToken,
      CONFIG.COOKIE_SETTINGS.nonce,
      CONFIG.COOKIE_SETTINGS.pkce
  ];
  
  const clearCookies = cookiesToClear.map(cookieName => ({
      key: 'Set-Cookie',
      value: `${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`
  }));
  
  console.log('Clearing authentication cookies and redirecting to Cognito logout');
  
  return {
      status: '302',
      statusDescription: 'Found',
      headers: {
          location: [{
              key: 'Location',
              value: logoutUrl
          }],
          'set-cookie': clearCookies,
          'cache-control': [{
              key: 'Cache-Control',
              value: 'no-cache, no-store, must-revalidate'
          }]
      }
  };
};