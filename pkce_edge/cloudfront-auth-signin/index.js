// Lambda@Edge Sign In Function
// This function initiates the OAuth flow when users visit /signin

const crypto = require('crypto');
const CONFIG = require('../config');

// Generate PKCE challenge
function generatePKCE() {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    return { codeVerifier, codeChallenge };
}

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
    
    console.log('Initiating sign in process');
    
    // Parse query parameters - allows specifying where to redirect after auth
    const params = parseQueryString(queryString);
    const redirectAfterAuth = params.redirect || '/';
    
    console.log('Will redirect to after authentication:', redirectAfterAuth);
    
    // Generate PKCE parameters for secure OAuth flow
    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = crypto.randomBytes(16).toString('hex');
    const nonce = crypto.randomBytes(16).toString('hex');
    
    // Build Cognito authorization URL with PKCE
    const authParams = new URLSearchParams({
        response_type: 'code',
        client_id: CONFIG.USER_POOL_CLIENT_ID,
        redirect_uri: CONFIG.REDIRECT_URI,
        scope: 'openid email profile',
        state: state,
        nonce: nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
    });
    
    const authUrl = `${CONFIG.USER_POOL_DOMAIN}/oauth2/authorize?${authParams.toString()}`;
    
    // Store PKCE and state data for callback verification
    const pkceData = JSON.stringify({
        codeVerifier,
        state,
        nonce,
        originalUri: redirectAfterAuth
    });
    
    console.log('Redirecting to Cognito authorization URL');
    
    return {
        status: '302',
        statusDescription: 'Found',
        headers: {
            location: [{
                key: 'Location',
                value: authUrl
            }],
            'set-cookie': [{
                key: 'Set-Cookie',
                value: `${CONFIG.COOKIE_SETTINGS.pkce}=${encodeURIComponent(pkceData)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`
            }],
            'cache-control': [{
                key: 'Cache-Control',
                value: 'no-cache, no-store, must-revalidate'
            }]
        }
    };
};