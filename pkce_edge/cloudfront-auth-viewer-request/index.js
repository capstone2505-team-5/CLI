// Lambda@Edge Viewer Request Function
// This function runs on every CloudFront request to check authentication

const crypto = require('crypto');

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
// Basic JWT validation (checks structure and expiration)
function validateJWT(token) {
    try {
        // Split JWT into parts
        const parts = token.split('.');
        if (parts.length !== 3) return false;
        
        // Decode payload
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        
        // Check expiration
        const now = Math.floor(Date.now() / 1000);
        if (payload.exp < now) {
            console.log('Token expired');
            return false;
        }
        
        // Check token type
        if (payload.token_use !== 'id') {
            console.log('Not an ID token');
            return false;
        }
        
        console.log('Token is valid');
        return true;
    } catch (error) {
        console.log('JWT validation error:', error.message);
        return false;
    }
}

// Generate PKCE challenge
function generatePKCE() {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    return { codeVerifier, codeChallenge };
}

// Create authentication redirect response
function createAuthRedirect(originalUri) {
    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = crypto.randomBytes(16).toString('hex');
    const nonce = crypto.randomBytes(16).toString('hex');
    
    // Build Cognito authorization URL with timestamp
    const authParams = new URLSearchParams({
        response_type: 'code',
        client_id: CONFIG.USER_POOL_CLIENT_ID,
        redirect_uri: CONFIG.REDIRECT_URI,
        scope: 'openid email profile',
        state: state,
        nonce: nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        _t: Date.now() // Add timestamp
    });
    
    const authUrl = `${CONFIG.USER_POOL_DOMAIN}/oauth2/authorize?${authParams.toString()}`;
    
    // Store PKCE data for callback
    const pkceData = JSON.stringify({
        codeVerifier,
        state,
        nonce,
        originalUri
    });
    
    console.log('Redirecting to authentication:', authUrl);
    
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
                value: 'no-cache, no-store, must-revalidate, max-age=0'
            }],
            'pragma': [{
                key: 'Pragma',
                value: 'no-cache'
            }],
            'expires': [{
                key: 'Expires',
                value: '0'
            }]
        }
    };
}

// Main Lambda handler
exports.handler = async (event) => {
    const request = event.Records[0].cf.request;
    const uri = request.uri;
    const headers = request.headers;
    
    console.log('Processing request for URI:', uri);
    
    // Skip authentication for public paths
    const publicPaths = ['/callback', '/signin', '/signout', '/favicon.ico', '/robots.txt'];
    if (publicPaths.some(path => uri.startsWith(path))) {
        console.log('Public path, allowing request');
        return request;
    }

    // Handle React routing - serve index.html for client-side routes (but not API calls)
    if (uri.includes('.') === false && uri !== '/' && !uri.startsWith('/api/')) {
        console.log('Client-side route detected, serving index.html');
        request.uri = '/index.html';
    }
    
    // Parse cookies
    const cookieHeader = headers.cookie ? headers.cookie[0].value : '';
    const cookies = parseCookies(cookieHeader);
    const idToken = cookies[CONFIG.COOKIE_SETTINGS.idToken];
    
    if (idToken && validateJWT(idToken)) {
        console.log('Valid authentication found, allowing request');
        return request;
    }
    
    console.log('No valid authentication, redirecting to login');
    
    // Add cache-busting to force fresh requests
    const separator = uri.includes('?') ? '&' : '?';
    const cacheBustedUri = `${uri}${separator}_t=${Date.now()}`;
    
    return createAuthRedirect(cacheBustedUri);
};