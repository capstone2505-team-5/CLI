// Lambda@Edge Origin Request Function for API Gateway
// This function extracts JWT tokens from cookies and adds them to Authorization header

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

// Main Lambda handler for API requests
exports.handler = async (event) => {
    const request = event.Records[0].cf.request;
    const headers = request.headers;
    
    console.log('Processing API request for URI:', request.uri);
    console.log('All incoming headers:', JSON.stringify(headers, null, 2));
    
    // Parse cookies to extract JWT tokens
    const cookieHeader = headers.cookie ? headers.cookie[0].value : '';
    console.log('Cookie header:', cookieHeader);
    const cookies = parseCookies(cookieHeader);
    console.log('Parsed cookies:', Object.keys(cookies));
    console.log('Looking for cookie:', CONFIG.COOKIE_SETTINGS.accessToken);
    
    // Get the access token from cookies (API Gateway expects access token, not ID token)
    const accessToken = cookies[CONFIG.COOKIE_SETTINGS.accessToken];
    
    if (accessToken) {
        console.log('Found access token in cookies, adding to Authorization header');
        
        // Add Authorization header with Bearer token for API Gateway
        const authHeaderValue = `Bearer ${accessToken}`;
        headers.authorization = [{
            key: 'Authorization',
            value: authHeaderValue
        }];
        
        console.log('Authorization header value:', authHeaderValue.substring(0, 50) + '...');
        console.log('Authorization header structure:', JSON.stringify(headers.authorization));
        
        // Remove cookie header to prevent it from being sent to API Gateway
        // (optional - keeps the request cleaner)
        delete headers.cookie;
        
        console.log('Authorization header added successfully');
    } else {
        console.log('No access token found in cookies - request will likely be rejected by API Gateway');
    }
    
    // Log final headers being sent to API Gateway
    console.log('Final request headers keys:', JSON.stringify(Object.keys(headers)));
    console.log('Final Authorization header:', JSON.stringify(headers.authorization));
    console.log('Complete final request:', JSON.stringify({
        uri: request.uri,
        method: request.method,
        headers: headers
    }, null, 2));
    
    // Forward the request to API Gateway
    return request;
}; 