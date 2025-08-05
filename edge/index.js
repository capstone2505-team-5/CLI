'use strict';

const jwt = require('jsonwebtoken');
const redirectToLogin = (host) => {
  const cognitoDomain = 'alexnovpn18.auth.us-west-2.amazoncognito.com'; // ← Replace this
  const clientId = '1dhjtv6f2j710uihipm9evl80'; // ← Replace this
  const redirectUri = 'https://dl0iv11hvs3np.cloudfront.net/callback'; // ← Replace this to match your callback URL

  const loginUrl = `https://${cognitoDomain}/login?client_id=${clientId}&response_type=token&scope=email+openid&redirect_uri=${redirectUri}`;
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
  const headers = request.headers;

  const host = headers.host[0].value;
  const cookies = headers.cookie ? headers.cookie[0].value : '';
  const idTokenMatch = cookies.match(/id_token=([^;]+)/);

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

    // You could also validate the token's issuer, audience, etc., here

    return request; // Allow the request to continue
  } catch (err) {
    console.log('Token decode failed:', err);
    return redirectToLogin(host);
  }
};
